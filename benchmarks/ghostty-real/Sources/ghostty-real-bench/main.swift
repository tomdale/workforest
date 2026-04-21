import AppKit
import Darwin
import Foundation
import GhosttyKit

struct BenchOptions {
    var workdir: String
    var command: String?
    var input: String?
    var outputPath: String?
    var width: Double = 1600
    var height: Double = 1000
    var fps: Double = 120
}

struct BenchResult: Codable {
    var wallMs: Double
    var userCpuMs: Double
    var systemCpuMs: Double
    var maxRssBytes: Int
    var drawCalls: Int
    var wakeups: Int
    var ticks: Int
    var processAliveOnClose: Bool
}

final class TerminalView: NSView {
    weak var controller: BenchmarkController?
    private(set) var surface: ghostty_surface_t?

    init(frame: NSRect, controller: BenchmarkController) {
        self.controller = controller
        super.init(frame: frame)

        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func createSurface(app: ghostty_app_t, options: BenchOptions) {
        var config = ghostty_surface_config_new()
        let workingDirectory = strdup(options.workdir)
        let command = options.command.map { strdup($0) }
        let initialInput = options.input.map { strdup($0) }
        config.platform_tag = GHOSTTY_PLATFORM_MACOS
        config.platform = ghostty_platform_u(
            macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(self).toOpaque())
        )
        config.userdata = Unmanaged.passUnretained(self).toOpaque()
        config.scale_factor = Double((window?.screen?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor) ?? 2.0)
        config.working_directory = workingDirectory != nil ? UnsafePointer(workingDirectory!) : nil
        config.command = command != nil ? UnsafePointer(command!) : nil
        config.initial_input = initialInput != nil ? UnsafePointer(initialInput!) : nil
        config.context = GHOSTTY_SURFACE_CONTEXT_WINDOW

        defer {
            if let workingDirectory {
                free(workingDirectory)
            }
            if let command {
                free(command)
            }
            if let initialInput {
                free(initialInput)
            }
        }

        guard let surface = ghostty_surface_new(app, &config) else {
            fputs("ghostty_surface_new failed\n", stderr)
            controller?.finish(processAliveOnClose: false)
            return
        }

        self.surface = surface
        updateSurfaceMetrics()
    }

    override var acceptsFirstResponder: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateSurfaceMetrics()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateSurfaceMetrics()
    }

    func updateSurfaceMetrics() {
        guard let surface else { return }

        let scale = window?.screen?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2.0
        ghostty_surface_set_content_scale(surface, scale, scale)
        ghostty_surface_set_focus(surface, window?.isKeyWindow ?? true)
        ghostty_surface_set_occlusion(surface, true)

        let backing = convertToBacking(bounds.size)
        let width = UInt32(max(backing.width.rounded(.down), 1))
        let height = UInt32(max(backing.height.rounded(.down), 1))
        ghostty_surface_set_size(surface, width, height)
    }

    func drawFrame() {
        guard let surface else { return }
        ghostty_surface_draw(surface)
    }

    func closeFromRuntime(processAlive: Bool) {
        controller?.finish(processAliveOnClose: processAlive)
    }
}

final class BenchmarkController: NSObject, NSApplicationDelegate, @unchecked Sendable {
    private let options: BenchOptions
    private var appPtr: ghostty_app_t?
    private var window: NSWindow?
    private var terminalView: TerminalView?
    private var drawTimer: Timer?
    private var wakeups = 0
    private var ticks = 0
    private var drawCalls = 0
    private var startWall = DispatchTime.now()
    private var startUsage = rusage()
    private var finished = false

    init(options: BenchOptions) {
        self.options = options
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = ghostty_config_new()
        guard let config else {
            fputs("failed to create ghostty config\n", stderr)
            NSApp.terminate(nil)
            return
        }

        ghostty_config_load_default_files(config)
        ghostty_config_load_recursive_files(config)
        ghostty_config_finalize(config)

        var runtimeConfig = ghostty_runtime_config_s(
            userdata: Unmanaged.passUnretained(self).toOpaque(),
            supports_selection_clipboard: false,
            wakeup_cb: benchmarkWakeupCallback,
            action_cb: benchmarkActionCallback,
            read_clipboard_cb: benchmarkReadClipboardCallback,
            confirm_read_clipboard_cb: benchmarkConfirmReadClipboardCallback,
            write_clipboard_cb: benchmarkWriteClipboardCallback,
            close_surface_cb: benchmarkCloseSurfaceCallback
        )

        guard let app = ghostty_app_new(&runtimeConfig, config) else {
            fputs("failed to create ghostty app\n", stderr)
            ghostty_config_free(config)
            NSApp.terminate(nil)
            return
        }

        ghostty_config_free(config)
        appPtr = app

        let frame = NSRect(x: 0, y: 0, width: options.width, height: options.height)
        let view = TerminalView(frame: frame, controller: self)
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Ghostty Real Benchmark"
        window.contentView = view
        window.makeFirstResponder(view)
        window.makeKeyAndOrderFront(nil)
        window.center()
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
        self.terminalView = view

        startWall = DispatchTime.now()
        getrusage(RUSAGE_SELF, &startUsage)

        view.createSurface(app: app, options: options)
        ghostty_app_set_focus(app, true)

        let interval = 1.0 / max(options.fps, 1)
        let timer = Timer(
            timeInterval: interval,
            target: self,
            selector: #selector(handleDrawTimer(_:)),
            userInfo: nil,
            repeats: true
        )
        drawTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        if !finished {
            emitResult(processAliveOnClose: terminalView?.surface.map { !ghostty_surface_process_exited($0) } ?? false)
        }
    }

    func scheduleTick() {
        wakeups += 1
        DispatchQueue.main.async {
            guard let app = self.appPtr else { return }
            self.ticks += 1
            ghostty_app_tick(app)
        }
    }

    func handleAction(target: ghostty_target_s, action: ghostty_action_s) -> Bool {
        switch action.tag {
        case GHOSTTY_ACTION_SET_TITLE:
            if target.tag == GHOSTTY_TARGET_SURFACE {
                let title = String(cString: action.action.set_title.title)
                DispatchQueue.main.async {
                    self.window?.title = title
                }
            }
            return true

        case GHOSTTY_ACTION_RENDERER_HEALTH:
            return true

        case GHOSTTY_ACTION_INITIAL_SIZE,
             GHOSTTY_ACTION_CELL_SIZE,
             GHOSTTY_ACTION_PWD,
             GHOSTTY_ACTION_PROGRESS_REPORT,
             GHOSTTY_ACTION_SCROLLBAR,
             GHOSTTY_ACTION_COMMAND_FINISHED,
             GHOSTTY_ACTION_SHOW_CHILD_EXITED,
             GHOSTTY_ACTION_MOUSE_SHAPE,
             GHOSTTY_ACTION_MOUSE_VISIBILITY,
             GHOSTTY_ACTION_MOUSE_OVER_LINK,
             GHOSTTY_ACTION_READONLY,
             GHOSTTY_ACTION_KEY_SEQUENCE,
             GHOSTTY_ACTION_KEY_TABLE,
             GHOSTTY_ACTION_COLOR_CHANGE,
             GHOSTTY_ACTION_START_SEARCH,
             GHOSTTY_ACTION_END_SEARCH,
             GHOSTTY_ACTION_SEARCH_TOTAL,
             GHOSTTY_ACTION_SEARCH_SELECTED:
            return true

        case GHOSTTY_ACTION_QUIT,
             GHOSTTY_ACTION_CLOSE_WINDOW:
            fputs("received close action from ghostty runtime\n", stderr)
            DispatchQueue.main.async {
                self.finish(processAliveOnClose: false)
            }
            return true

        default:
            return false
        }
    }

    @MainActor
    @objc private func handleDrawTimer(_ timer: Timer) {
        drawCalls += 1
        terminalView?.drawFrame()
        if let surface = terminalView?.surface, ghostty_surface_process_exited(surface) {
            finish(processAliveOnClose: false)
        }
    }

    @MainActor
    func finish(processAliveOnClose: Bool) {
        if finished { return }
        emitResult(processAliveOnClose: processAliveOnClose)

        NSApp.terminate(nil)
    }

    private func emitResult(processAliveOnClose: Bool) {
        if finished { return }
        finished = true

        drawTimer?.invalidate()
        drawTimer = nil

        var endUsage = rusage()
        getrusage(RUSAGE_SELF, &endUsage)

        let wallMs = Double(DispatchTime.now().uptimeNanoseconds - startWall.uptimeNanoseconds) / 1_000_000
        let result = BenchResult(
            wallMs: wallMs,
            userCpuMs: timevalDiffMs(startUsage.ru_utime, endUsage.ru_utime),
            systemCpuMs: timevalDiffMs(startUsage.ru_stime, endUsage.ru_stime),
            maxRssBytes: Int(endUsage.ru_maxrss),
            drawCalls: drawCalls,
            wakeups: wakeups,
            ticks: ticks,
            processAliveOnClose: processAliveOnClose
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(result),
              let json = String(data: data, encoding: .utf8) else {
            return
        }

        print(json)
        if let outputPath = options.outputPath {
            try? json.write(toFile: outputPath, atomically: true, encoding: .utf8)
        }
    }
}

private func benchmarkWakeupCallback(_ userdata: UnsafeMutableRawPointer?) {
    guard let userdata else { return }
    let controller = Unmanaged<BenchmarkController>.fromOpaque(userdata).takeUnretainedValue()
    controller.scheduleTick()
}

private func benchmarkActionCallback(
    _ app: ghostty_app_t?,
    _ target: ghostty_target_s,
    _ action: ghostty_action_s
) -> Bool {
    guard let app else { return false }
    guard let userdata = ghostty_app_userdata(app) else { return false }
    let controller = Unmanaged<BenchmarkController>.fromOpaque(userdata).takeUnretainedValue()
    return controller.handleAction(target: target, action: action)
}

private func benchmarkReadClipboardCallback(
    _ userdata: UnsafeMutableRawPointer?,
    _ location: ghostty_clipboard_e,
    _ state: UnsafeMutableRawPointer?
) -> Bool {
    false
}

private func benchmarkConfirmReadClipboardCallback(
    _ userdata: UnsafeMutableRawPointer?,
    _ value: UnsafePointer<CChar>?,
    _ state: UnsafeMutableRawPointer?,
    _ request: ghostty_clipboard_request_e
) {
}

private func benchmarkWriteClipboardCallback(
    _ userdata: UnsafeMutableRawPointer?,
    _ location: ghostty_clipboard_e,
    _ content: UnsafePointer<ghostty_clipboard_content_s>?,
    _ len: Int,
    _ confirm: Bool
) {
}

private func benchmarkCloseSurfaceCallback(
    _ userdata: UnsafeMutableRawPointer?,
    _ processAlive: Bool
) {
    guard let userdata else { return }
    let view = Unmanaged<TerminalView>.fromOpaque(userdata).takeUnretainedValue()
    DispatchQueue.main.async {
        view.closeFromRuntime(processAlive: processAlive)
    }
}

private func timevalDiffMs(_ lhs: timeval, _ rhs: timeval) -> Double {
    let seconds = Double(rhs.tv_sec - lhs.tv_sec) * 1000
    let micros = Double(rhs.tv_usec - lhs.tv_usec) / 1000
    return seconds + micros
}

private func parseArgs() -> BenchOptions {
    var args = Array(CommandLine.arguments.dropFirst())
    var workdir = FileManager.default.currentDirectoryPath
    var command: String? = "pnpm exec tsx benchmarks/tui-grid-session.ts --repos 9 --lines 120 --line-width 48"
    var input: String?
    var outputPath: String?
    var width = 1600.0
    var height = 1000.0
    var fps = 120.0

    while !args.isEmpty {
        let arg = args.removeFirst()
        switch arg {
        case "--workdir":
            if !args.isEmpty { workdir = args.removeFirst() }
        case "--command":
            if !args.isEmpty { command = args.removeFirst() }
        case "--input":
            if !args.isEmpty { input = args.removeFirst() }
        case "--output":
            if !args.isEmpty { outputPath = args.removeFirst() }
        case "--width":
            if let value = args.first, let parsed = Double(value) {
                width = parsed
                args.removeFirst()
            }
        case "--height":
            if let value = args.first, let parsed = Double(value) {
                height = parsed
                args.removeFirst()
            }
        case "--fps":
            if let value = args.first, let parsed = Double(value) {
                fps = parsed
                args.removeFirst()
            }
        default:
            continue
        }
    }

    return BenchOptions(
        workdir: workdir,
        command: command,
        input: input,
        outputPath: outputPath,
        width: width,
        height: height,
        fps: fps
    )
}

let controller = BenchmarkController(options: parseArgs())
if ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv) != GHOSTTY_SUCCESS {
    fputs("ghostty_init failed\n", stderr)
    exit(1)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.delegate = controller
app.run()
