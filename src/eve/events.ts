import type {
  AuthorizationRequiredStreamEvent,
  HandleMessageStreamEvent,
  InputRequestedStreamEvent,
  MessageAppendedStreamEvent,
  MessageCompletedStreamEvent,
  SessionCompletedStreamEvent,
  SessionFailedStreamEvent,
  SessionState,
  SessionWaitingStreamEvent,
} from "eve/client";

export type EveTurnUpdate =
  | {
      readonly type: "message.appended";
      readonly messageDelta: string;
      readonly message: string;
      readonly raw: MessageAppendedStreamEvent;
    }
  | {
      readonly type: "message.completed";
      readonly message: string | null;
      readonly finishReason: string;
      readonly raw: MessageCompletedStreamEvent;
    }
  | {
      readonly type: "session.waiting";
      readonly sessionState: SessionState;
      readonly raw: SessionWaitingStreamEvent;
    }
  | {
      readonly type: "session.completed";
      readonly sessionState: SessionState;
      readonly raw: SessionCompletedStreamEvent;
    }
  | {
      readonly type: "session.failed";
      readonly error: string;
      readonly code?: string;
      readonly sessionState?: SessionState;
      readonly raw: SessionFailedStreamEvent;
    }
  | {
      readonly type: "input.requested";
      readonly requests: InputRequestedStreamEvent["data"]["requests"];
      readonly raw: InputRequestedStreamEvent;
    }
  | {
      readonly type: "authorization.required";
      readonly name: string;
      readonly description: string;
      readonly raw: AuthorizationRequiredStreamEvent;
    }
  | {
      readonly type: "raw";
      readonly raw: HandleMessageStreamEvent;
    };

export function normalizeEveTurnEvent(event: HandleMessageStreamEvent, sessionState?: SessionState): EveTurnUpdate {
  switch (event.type) {
    case "message.appended":
      return normalizeMessageAppended(event);
    case "message.completed":
      return normalizeMessageCompleted(event);
    case "session.waiting":
      return normalizeSessionWaiting(event, requireSessionState(sessionState, event.type));
    case "session.completed":
      return normalizeSessionCompleted(event, requireSessionState(sessionState, event.type));
    case "session.failed":
      return normalizeSessionFailed(event, sessionState);
    case "input.requested":
      return normalizeInputRequested(event);
    case "authorization.required":
      return normalizeAuthorizationRequired(event);
    default:
      return { type: "raw", raw: event };
  }
}

export function normalizeMessageAppended(event: MessageAppendedStreamEvent): EveTurnUpdate {
  return {
    type: "message.appended",
    messageDelta: event.data.messageDelta,
    message: event.data.messageSoFar,
    raw: event,
  };
}

export function normalizeMessageCompleted(event: MessageCompletedStreamEvent): EveTurnUpdate {
  return {
    type: "message.completed",
    message: event.data.message,
    finishReason: event.data.finishReason,
    raw: event,
  };
}

export function normalizeSessionWaiting(event: SessionWaitingStreamEvent, sessionState: SessionState): EveTurnUpdate {
  return { type: "session.waiting", sessionState, raw: event };
}

export function normalizeSessionCompleted(event: SessionCompletedStreamEvent, sessionState: SessionState): EveTurnUpdate {
  return { type: "session.completed", sessionState, raw: event };
}

export function normalizeSessionFailed(event: SessionFailedStreamEvent, sessionState?: SessionState): EveTurnUpdate {
  return {
    type: "session.failed",
    error: event.data.message,
    code: event.data.code,
    sessionState,
    raw: event,
  };
}

export function normalizeInputRequested(event: InputRequestedStreamEvent): EveTurnUpdate {
  return { type: "input.requested", requests: event.data.requests, raw: event };
}

export function normalizeAuthorizationRequired(event: AuthorizationRequiredStreamEvent): EveTurnUpdate {
  return {
    type: "authorization.required",
    name: event.data.name,
    description: event.data.description,
    raw: event,
  };
}

function requireSessionState(sessionState: SessionState | undefined, eventType: string): SessionState {
  if (!sessionState) {
    throw new Error(`Cannot normalize ${eventType} without session state`);
  }

  return sessionState;
}
