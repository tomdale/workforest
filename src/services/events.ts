export type ServiceEvent =
  | {
      type: "message";
      level: "info" | "warning" | "success" | "error";
      message: string;
    }
  | {
      type: "output";
      stream: "stdout" | "stderr";
      data: string;
    };

export type ServiceEventSink = (event: ServiceEvent) => void;

export function emitServiceEvent(
  sink: ServiceEventSink | undefined,
  event: ServiceEvent,
): void {
  sink?.(event);
}
