import type {
  TelegramAttachmentKind,
  TelegramContentKind,
} from "../telegram/types";

export type LogEventFields = {
  service_config_loaded: {
    allowed_user_count: number;
    stream_responses: boolean;
  };
  service_started: {
    process_id: number;
  };
  service_start_failed: FailureFields<"startup_failed">;
  service_stop_requested: {
    signal: "SIGINT" | "SIGTERM";
  };
  service_stopping: {
    signal: "SIGINT" | "SIGTERM";
  };
  service_stopped: {
    duration_ms: number;
  };
  service_stop_failed: FailureFields<"shutdown_failed" | "shutdown_timeout">;
  service_stop_forced: {
    signal: "SIGINT" | "SIGTERM";
  };
  telegram_update_ignored: {
    update_id: number;
    reason:
      | "stale_update"
      | "disallowed_user"
      | "non_private_chat"
      | "duplicate_message"
      | "service_stopping";
  };
  telegram_message_accepted: {
    update_id: number;
    chat_id: number;
    message_id: number;
    attachment_count: number;
    photo_count: number;
    document_count: number;
    has_forward: boolean;
    has_reply: boolean;
    has_quote: boolean;
    message_type: TelegramContentKind | "mixed";
  };
  telegram_command_accepted: {
    update_id: number;
    chat_id: number;
    message_id: number;
    command: "new" | "status" | "stop" | "compact" | "restart";
  };
  telegram_command_result: {
    update_id: number;
    chat_id: number;
    message_id: number;
    command: "new" | "status" | "stop" | "compact" | "restart";
    status: "succeeded" | "failed";
  };
  telegram_input_rejected: {
    update_id: number;
    chat_id: number;
    message_id: number;
    reason: "missing_sender" | "unsupported_message";
  };
  telegram_update_failed: FailureFields<"update_handler_failed"> & {
    update_id: number;
  };
  telegram_dispatch_failed: FailureFields<
    | "message_dispatch_failed"
    | "new_session_dispatch_failed"
    | "status_dispatch_failed"
    | "stop_dispatch_failed"
    | "compact_dispatch_failed"
    | "restart_dispatch_failed"
  > & {
    update_id: number;
    chat_id: number;
    message_id: number;
  };
  telegram_file_download_started: TelegramFileFields;
  telegram_file_download_succeeded: TelegramFileFields & {
    cache_hit: boolean;
    duration_ms: number;
  };
  telegram_file_download_failed: TelegramFileFields &
    FailureFields<
      | "declared_too_large"
      | "get_file_failed"
      | "file_path_missing"
      | "fetch_failed"
      | "http_failed"
      | "response_too_large"
      | "write_failed"
    > & {
      http_status?: number;
    };
  telegram_outbound_started: TelegramOutboundFields & {
    file_size_bytes: number;
  };
  telegram_outbound_sent: TelegramOutboundFields & {
    telegram_message_id: number;
    file_size_bytes: number;
    indexed: boolean;
    duration_ms: number;
  };
  telegram_outbound_rejected: TelegramOutboundFields & {
    error_name: string;
    reason: string;
  };
  telegram_outbound_unknown: TelegramOutboundFields & {
    error_name: string;
    reason: string;
  };
  telegram_outbound_index_failed: {
    chat_id: number;
    telegram_message_id: number;
    attachment_kind: "document" | "photo";
    error_name: string;
    reason: "state_persist_failed" | "state_persist_timeout";
  };
  telegram_reply_sent: {
    chat_id: number;
    reply_to_message_id: number;
    chunks_sent: number;
    fallback_count: number;
    duration_ms: number;
  };
  telegram_reply_failed: FailureFields<
    "markdown_send_failed" | "plain_send_failed" | "state_persist_failed"
  > & {
    chat_id: number;
    reply_to_message_id: number;
    chunks_sent: number;
    chunks_total: number;
  };
  telegram_draft_failed: FailureFields<"draft_send_failed"> & {
    chat_id: number;
    reply_to_message_id: number;
    revision: number;
    segment: number;
  };
  telegram_activity_failed: FailureFields<
    "typing_failed" | "status_send_failed" | "status_edit_failed"
  > & {
    chat_id: number;
    action: "typing" | "send_tool_status" | "edit_tool_status";
  };
  telegram_status_failed: FailureFields<"status_send_failed"> & {
    chat_id: number;
    message_id: number;
  };
  pi_agent_create_started: {
    chat_id: number;
    resume_session: boolean;
  };
  pi_agent_create_failed: FailureFields<"agent_create_failed"> & {
    chat_id: number;
  };
  pi_agent_recovery_started: {
    chat_id: number;
  };
  pi_agent_recovered: {
    chat_id: number;
  };
  pi_agent_recovery_failed: FailureFields<"agent_recovery_failed"> & {
    chat_id: number;
  };
  pi_session_ready: {
    chat_id: number;
    resumed: boolean;
    is_streaming: boolean;
    pending_message_count: number;
  };
  pi_session_reset_started: {
    chat_id: number;
    message_id: number;
  };
  pi_session_reset_succeeded: {
    chat_id: number;
    message_id: number;
  };
  pi_operation_failed: FailureFields<"operation_failed"> & {
    chat_id: number;
    message_id?: number;
  };
  pi_input_suppressed: {
    chat_id: number;
    message_id: number;
    reason: "already_seen";
  };
  pi_prompt_sent: PiCommandFields;
  pi_steer_sent: PiCommandFields;
  pi_abort_sent: {
    chat_id: number;
    message_id: number;
    revision: number;
    reason: "new_session" | "newer_message" | "stop_command";
  };
  pi_abort_completed: {
    chat_id: number;
    message_id: number;
    revision: number;
  };
  pi_agent_settled: {
    chat_id: number;
    revision: number;
    candidate_present: boolean;
    queued_steer_count: number;
  };
  pi_response_suppressed: {
    chat_id: number;
    message_id: number;
    revision: number;
    reason: "aborted" | "empty_response" | "newer_revision" | "queued_steer";
  };
  pi_queue_recovery_started: {
    chat_id: number;
    item_count: number;
    reason: "stranded_queue" | "abort_reconcile" | "missing_activation";
  };
  pi_queue_recovery_succeeded: {
    chat_id: number;
    item_count: number;
  };
  pi_queue_recovery_failed: FailureFields<"queue_recovery_failed"> & {
    chat_id: number;
    item_count: number;
  };
  pi_agent_fatal: FailureFields<"rpc_process_failed"> & {
    chat_id: number;
    revision: number;
  };
  pi_tool_started: PiToolFields & {
    status: "running";
  };
  pi_tool_finished: PiToolFields & {
    status: "succeeded" | "failed";
  };
  pi_rpc_listener_failed: FailureFields<
    "event_listener_failed" | "fatal_listener_failed"
  >;
  pi_extension_response_failed: FailureFields<"telegram_tool_response_failed"> & {
    chat_id: number;
  };
};

export type LogEvent = keyof LogEventFields;

export const LOG_FIELD_NAMES = {
  service_config_loaded: ["allowed_user_count", "stream_responses"],
  service_started: ["process_id"],
  service_start_failed: ["error_name", "reason"],
  service_stop_requested: ["signal"],
  service_stopping: ["signal"],
  service_stopped: ["duration_ms"],
  service_stop_failed: ["error_name", "reason"],
  service_stop_forced: ["signal"],
  telegram_update_ignored: ["update_id", "reason"],
  telegram_message_accepted: [
    "update_id",
    "chat_id",
    "message_id",
    "attachment_count",
    "photo_count",
    "document_count",
    "has_forward",
    "has_reply",
    "has_quote",
    "message_type",
  ],
  telegram_command_accepted: ["update_id", "chat_id", "message_id", "command"],
  telegram_command_result: [
    "update_id",
    "chat_id",
    "message_id",
    "command",
    "status",
  ],
  telegram_input_rejected: ["update_id", "chat_id", "message_id", "reason"],
  telegram_update_failed: ["update_id", "error_name", "reason"],
  telegram_dispatch_failed: [
    "update_id",
    "chat_id",
    "message_id",
    "error_name",
    "reason",
  ],
  telegram_file_download_started: [
    "chat_id",
    "message_id",
    "attachment_kind",
    "file_unique_id",
    "file_size_bytes",
  ],
  telegram_file_download_succeeded: [
    "chat_id",
    "message_id",
    "attachment_kind",
    "file_unique_id",
    "file_size_bytes",
    "cache_hit",
    "duration_ms",
  ],
  telegram_file_download_failed: [
    "chat_id",
    "message_id",
    "attachment_kind",
    "file_unique_id",
    "file_size_bytes",
    "error_name",
    "reason",
    "http_status",
  ],
  telegram_outbound_started: [
    "chat_id",
    "reply_to_message_id",
    "attachment_kind",
    "file_size_bytes",
  ],
  telegram_outbound_sent: [
    "chat_id",
    "reply_to_message_id",
    "telegram_message_id",
    "attachment_kind",
    "file_size_bytes",
    "indexed",
    "duration_ms",
  ],
  telegram_outbound_rejected: [
    "chat_id",
    "reply_to_message_id",
    "attachment_kind",
    "error_name",
    "reason",
  ],
  telegram_outbound_unknown: [
    "chat_id",
    "reply_to_message_id",
    "attachment_kind",
    "error_name",
    "reason",
  ],
  telegram_outbound_index_failed: [
    "chat_id",
    "telegram_message_id",
    "attachment_kind",
    "error_name",
    "reason",
  ],
  telegram_reply_sent: [
    "chat_id",
    "reply_to_message_id",
    "chunks_sent",
    "fallback_count",
    "duration_ms",
  ],
  telegram_reply_failed: [
    "chat_id",
    "reply_to_message_id",
    "chunks_sent",
    "chunks_total",
    "error_name",
    "reason",
  ],
  telegram_draft_failed: [
    "chat_id",
    "reply_to_message_id",
    "revision",
    "segment",
    "error_name",
    "reason",
  ],
  telegram_activity_failed: ["chat_id", "action", "error_name", "reason"],
  telegram_status_failed: ["chat_id", "message_id", "error_name", "reason"],
  pi_agent_create_started: ["chat_id", "resume_session"],
  pi_agent_create_failed: ["chat_id", "error_name", "reason"],
  pi_agent_recovery_started: ["chat_id"],
  pi_agent_recovered: ["chat_id"],
  pi_agent_recovery_failed: ["chat_id", "error_name", "reason"],
  pi_session_ready: [
    "chat_id",
    "resumed",
    "is_streaming",
    "pending_message_count",
  ],
  pi_session_reset_started: ["chat_id", "message_id"],
  pi_session_reset_succeeded: ["chat_id", "message_id"],
  pi_operation_failed: ["chat_id", "message_id", "error_name", "reason"],
  pi_input_suppressed: ["chat_id", "message_id", "reason"],
  pi_prompt_sent: ["chat_id", "message_id", "revision", "image_count"],
  pi_steer_sent: ["chat_id", "message_id", "revision", "image_count"],
  pi_abort_sent: ["chat_id", "message_id", "revision", "reason"],
  pi_abort_completed: ["chat_id", "message_id", "revision"],
  pi_agent_settled: [
    "chat_id",
    "revision",
    "candidate_present",
    "queued_steer_count",
  ],
  pi_response_suppressed: ["chat_id", "message_id", "revision", "reason"],
  pi_queue_recovery_started: ["chat_id", "item_count", "reason"],
  pi_queue_recovery_succeeded: ["chat_id", "item_count"],
  pi_queue_recovery_failed: ["chat_id", "item_count", "error_name", "reason"],
  pi_agent_fatal: ["chat_id", "revision", "error_name", "reason"],
  pi_tool_started: ["chat_id", "tool_call_id", "tool_name", "status"],
  pi_tool_finished: ["chat_id", "tool_call_id", "tool_name", "status"],
  pi_rpc_listener_failed: ["error_name", "reason"],
  pi_extension_response_failed: ["chat_id", "error_name", "reason"],
} as const satisfies {
  [Event in LogEvent]: readonly (keyof LogEventFields[Event] & string)[];
};

interface FailureFields<Reason extends string> {
  error_name: string;
  reason: Reason;
}

interface TelegramFileFields {
  chat_id: number;
  message_id: number;
  attachment_kind: TelegramAttachmentKind;
  file_unique_id: string;
  file_size_bytes?: number;
}

interface TelegramOutboundFields {
  chat_id: number;
  reply_to_message_id: number;
  attachment_kind: "document" | "photo";
}

interface PiCommandFields {
  chat_id: number;
  message_id: number;
  revision: number;
  image_count: number;
}

interface PiToolFields {
  chat_id: number;
  tool_call_id: string;
  tool_name: string;
}
