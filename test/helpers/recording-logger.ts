import type { LogEvent, LogEventFields } from "../../src/logging/events";
import type { InfoLogger } from "../../src/logging/logger";

export interface RecordedLog<Event extends LogEvent = LogEvent> {
  event: Event;
  fields: Readonly<LogEventFields[Event]>;
}

export class RecordingLogger implements InfoLogger {
  readonly entries: RecordedLog[] = [];

  info<Event extends LogEvent>(
    event: Event,
    fields: Readonly<LogEventFields[Event]>,
  ): void {
    this.entries.push({ event, fields });
  }

  events(): LogEvent[] {
    return this.entries.map((entry) => entry.event);
  }
}
