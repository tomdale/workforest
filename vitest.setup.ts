// The Claude Code harness exports FORCE_COLOR=3 into the environment of every
// process it spawns (so tool output is colorized in the captured terminal).
// That diverges from real dev/CI terminals, where these CLIs run color-disabled
// when their output is piped — and it makes Node warn when a test also sets
// NO_COLOR. Neutralize it here so the suite exercises the genuine non-TTY
// behavior and stays deterministic regardless of the ambient terminal. Tests
// that specifically exercise colored output set FORCE_COLOR on their own child
// env (see bin.test.ts), which is unaffected by this process-level deletion.
delete process.env["FORCE_COLOR"];
