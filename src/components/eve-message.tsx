"use client";

import { useEffect, useState } from "react";
import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessageInputRequest,
  EveMessagePart,
} from "eve/react";
import type { InputResponse } from "eve/client";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  BookOpenIcon,
  CheckIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  XCircleIcon,
} from "lucide-react";

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
  type ConfirmationProps,
} from "@/components/ai-elements/confirmation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  BashToolContent,
  getStatusBadge,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolStatus,
} from "@/components/ai-elements/tool";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;

/** The input requests Eve is parked on, and the answers collected for them so far. */
export type InputRequestBatch = {
  /** False while the thread cannot send at all: read-only, busy, or completed. */
  canRespond: boolean;
  /** Answers held back until every request in the batch has one, by request ID. */
  drafts: ReadonlyMap<string, InputResponse>;
  /** Request IDs Eve is waiting on right now. */
  pending: ReadonlySet<string>;
  respond: (response: InputResponse) => void | Promise<void>;
};

type EveMessageViewProps = {
  inputRequests: InputRequestBatch;
  isStreaming: boolean;
  message: EveMessage;
};

export function EveMessageView({
  inputRequests,
  isStreaming,
  message,
}: EveMessageViewProps): React.ReactElement {
  const lastTextIndex = message.parts.reduce(
    (last, part, index) => (part.type === "text" ? index : last),
    -1,
  );

  return (
    <Message
      data-optimistic={message.metadata?.optimistic ? "true" : undefined}
      from={message.role}
    >
      <MessageContent>
        {message.parts.map((part, index) => (
          <EveMessagePartView
            inputRequests={inputRequests}
            key={partKey(part, index)}
            part={part}
            showCaret={isStreaming && message.role === "assistant" && index === lastTextIndex}
          />
        ))}
      </MessageContent>
    </Message>
  );
}

function EveMessagePartView({
  inputRequests,
  part,
  showCaret,
}: {
  inputRequests: InputRequestBatch;
  part: EveMessagePart;
  showCaret: boolean;
}): React.ReactNode {
  switch (part.type) {
    case "step-start":
      return null;
    case "text":
      return (
        <MessageResponse caret="block" isAnimating={showCaret}>
          {part.text}
        </MessageResponse>
      );
    case "reasoning":
      return (
        <Reasoning defaultOpen={part.state === "streaming"} isStreaming={part.state === "streaming"}>
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    case "file":
      return <FilePart part={part} />;
    case "authorization":
      return <AuthorizationPart part={part} />;
    case "dynamic-tool":
      return <DynamicToolPartView inputRequests={inputRequests} part={part} />;
  }
}

function DynamicToolPartView({
  inputRequests,
  part,
}: {
  inputRequests: InputRequestBatch;
  part: EveDynamicToolPart;
}): React.ReactElement {
  const state = displayState(part, inputRequests);
  const [open, setOpen] = useState(state === "approval-requested");
  const isQuestion = part.toolMetadata?.eve?.inputRequest?.kind === "question";

  useEffect(() => {
    if (state === "approval-requested") {
      setOpen(true);
    }
  }, [state]);

  if (isLoadSkillPart(part)) {
    return <LoadSkillPart inputRequests={inputRequests} part={part} state={state} />;
  }

  return (
    <Tool onOpenChange={setOpen} open={open}>
      <ToolHeader
        state={state}
        title={part.toolName}
        toolName={part.toolName}
        type="dynamic-tool"
      />
      <ToolContent>
        {part.state === "input-streaming" ? (
          <ToolInput input={part.input} inputText={part.inputText} />
        ) : part.toolName === "bash" ? (
          <BashToolContent
            errorText={part.errorText}
            input={part.input}
            output={part.output}
          />
        ) : isQuestion ? null : (
          <ToolInput input={part.input} />
        )}
        <InputRequestPart inputRequests={inputRequests} part={part} state={state} />
        {part.toolName === "bash" || isQuestion ? null : (
          <ToolOutput errorText={part.errorText} output={part.output} />
        )}
      </ToolContent>
    </Tool>
  );
}

/**
 * The eve metadata classifies framework skill loads; the tool name covers a
 * part whose projection carried no eve metadata.
 */
function isLoadSkillPart(part: EveDynamicToolPart): boolean {
  return part.toolMetadata?.eve?.kind === "load-skill" || part.toolName === "load_skill";
}

/**
 * A skill load renders as a name and a lifecycle badge, with no expandable
 * body: the tool result is the agent's own instruction text, which must never
 * reach the transcript. Eve's own dev TUI and Slack channel present it the
 * same way.
 */
function LoadSkillPart({
  inputRequests,
  part,
  state,
}: {
  inputRequests: InputRequestBatch;
  part: EveDynamicToolPart;
  state: ToolStatus;
}): React.ReactElement {
  const skill = skillNameFromInput(part.input);

  return (
    <div className="not-prose w-full">
      <div className="flex items-center gap-2 py-0.5 text-muted-foreground">
        <BookOpenIcon className="size-4 text-muted-foreground" />
        <span className="text-sm">
          {part.state === "output-available" ? "Loaded" : "Load"} skill
          {skill ? ` · ${skill}` : ""}
        </span>
        {getStatusBadge(state)}
      </div>
      {part.toolMetadata?.eve?.inputRequest ? (
        <div className="pt-2">
          <InputRequestPart inputRequests={inputRequests} part={part} state={state} />
        </div>
      ) : null}
    </div>
  );
}

function skillNameFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const skill = (input as { skill?: unknown }).skill;
  return typeof skill === "string" && skill.trim().length > 0 ? skill.trim() : undefined;
}

/**
 * Whether the thread can still answer decides the state, not the projection.
 * The store marks a part answered before the turn is posted and never rolls
 * that back, and an input request Eve moved past keeps `approval-requested`
 * forever because Eve records no outcome for one. A part nobody is waiting on
 * that still carries no answer reads as dismissed rather than claiming a
 * response nobody has.
 */
function displayState(
  part: EveDynamicToolPart,
  inputRequests: InputRequestBatch,
): ToolStatus {
  const requestId = part.toolMetadata?.eve?.inputRequest?.requestId;
  if (requestId === undefined) {
    return part.state;
  }
  if (inputRequests.pending.has(requestId)) {
    return "approval-requested";
  }
  return part.state === "approval-requested" ? "input-dismissed" : part.state;
}

function FilePart({ part }: { part: EveFilePart }): React.ReactElement {
  const data = {
    id: `file:${part.filename ?? part.url ?? part.mediaType}`,
    type: "file" as const,
    filename: part.filename,
    mediaType: part.mediaType,
    url: part.url ?? "",
  };
  const content = (
    <Attachments className="min-w-0 max-w-full" variant="inline">
      <Attachment className="h-auto max-w-full py-1.5" data={data}>
        <AttachmentPreview />
        <AttachmentInfo showMediaType />
        {part.url ? (
          <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
      </Attachment>
    </Attachments>
  );

  return part.url ? (
    <a
      className="block min-w-0 max-w-full"
      href={part.url}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  ) : (
    content
  );
}

function InputRequestPart({
  inputRequests,
  part,
  state,
}: {
  inputRequests: InputRequestBatch;
  part: EveDynamicToolPart;
  state: ToolStatus;
}): React.ReactElement | null {
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  if (!inputRequest) {
    return null;
  }

  const pending = inputRequests.pending.has(inputRequest.requestId);
  const draft = inputRequests.drafts.get(inputRequest.requestId);
  // While the thread is still waiting on a request, any projected response is
  // optimistic: the draft is the answer, and it has not reached Eve yet.
  const submitted = pending ? undefined : part.toolMetadata?.eve?.inputResponse;
  const inputResponse = submitted ?? draft;
  const selectedOption = inputRequest.options?.find(
    (option) => option.id === inputResponse?.optionId,
  );

  return (
    <Confirmation approval={confirmationApproval(part)} state={state}>
      <ConfirmationTitle>{inputRequest.prompt}</ConfirmationTitle>
      {submitted ? null : (
        // A draft keeps its controls: the rest of the batch may still be
        // unanswered, and an answer is not final until every request has one.
        <ConfirmationRequest>
          <InputRequestControls
            canRespond={inputRequests.canRespond && pending}
            draft={draft}
            inputRequest={inputRequest}
            onInputResponse={inputRequests.respond}
          />
        </ConfirmationRequest>
      )}
      {inputResponse ? (
        <p className="text-sm font-medium">
          {submitted ? "Responded" : "Selected"}:{" "}
          {selectedOption?.label ?? inputResponse.text ?? inputResponse.optionId}
        </p>
      ) : null}
    </Confirmation>
  );
}

function confirmationApproval(part: EveDynamicToolPart): ConfirmationProps["approval"] {
  const approval = part.approval;
  if (!approval) {
    return undefined;
  }
  if (approval.approved === true) {
    return { id: approval.id, approved: true, reason: approval.reason };
  }
  if (approval.approved === false) {
    return { id: approval.id, approved: false, reason: approval.reason };
  }
  return { id: approval.id };
}

function InputRequestControls({
  canRespond,
  draft,
  inputRequest,
  onInputResponse,
}: {
  canRespond: boolean;
  draft: InputResponse | undefined;
  inputRequest: EveMessageInputRequest;
  onInputResponse: (response: InputResponse) => void | Promise<void>;
}): React.ReactElement {
  const [text, setText] = useState(draft?.text ?? "");
  const acceptsText =
    inputRequest.display === "text" ||
    inputRequest.allowFreeform === true ||
    (inputRequest.options?.length ?? 0) === 0;

  const submitText = (): void => {
    const response = text.trim();
    if (!response || !canRespond) {
      return;
    }
    void onInputResponse({ requestId: inputRequest.requestId, text: response });
  };

  // Blur is the commit the user actually performs when moving to the next
  // card: first-time text must land in the drafts or a multi-question batch
  // never completes, and text edited after its draft landed must re-commit or
  // the field shows one answer while the wire carries another.
  const commitTextOnBlur = (): void => {
    const response = text.trim();
    if (!canRespond || !response || response === draft?.text) {
      return;
    }
    void onInputResponse({ requestId: inputRequest.requestId, text: response });
  };

  return (
    <div className="flex flex-col gap-3 pt-2">
      {inputRequest.options?.length ? (
        <ConfirmationActions className="w-full flex-col items-stretch self-stretch">
          {inputRequest.options.map((option, index) => (
            <ConfirmationAction
              aria-label={option.label}
              aria-pressed={draft?.optionId === option.id}
              className={cn(
                "h-auto min-h-11 w-full justify-start gap-3 whitespace-normal px-3 py-2.5 text-left",
                draft?.optionId === option.id && "ring-2 ring-ring ring-offset-1",
              )}
              disabled={!canRespond}
              key={option.id}
              onClick={() => {
                void onInputResponse({
                  requestId: inputRequest.requestId,
                  optionId: option.id,
                });
              }}
              variant={
                option.style === "danger"
                  ? "destructive"
                  : option.style === "primary"
                    ? "default"
                    : "outline"
              }
            >
              <span className="w-5 shrink-0 text-center font-mono text-muted-foreground text-xs tabular-nums">
                {index + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-sm">{option.label}</span>
                {option.description ? (
                  <span className="text-muted-foreground text-xs leading-relaxed">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {draft?.optionId === option.id ? (
                <CheckIcon className="size-4 shrink-0" data-icon="inline-end" />
              ) : (
                <ArrowRightIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  data-icon="inline-end"
                />
              )}
            </ConfirmationAction>
          ))}
        </ConfirmationActions>
      ) : null}
      {acceptsText ? (
        <InputGroup>
          <InputGroupTextarea
            aria-label="Response"
            className="max-h-40 min-h-20"
            disabled={!canRespond}
            onBlur={commitTextOnBlur}
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submitText();
              }
            }}
            placeholder="Type a response…"
            value={text}
          />
          <InputGroupAddon align="block-end" className="justify-end pt-0">
            <InputGroupButton
              aria-label="Submit response"
              disabled={!canRespond || text.trim().length === 0}
              onClick={submitText}
              size="icon-sm"
              variant="default"
            >
              <ArrowUpIcon data-icon="inline-end" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      ) : null}
    </div>
  );
}

function AuthorizationPart({ part }: { part: EveAuthorizationPart }): React.ReactElement {
  const isAuthorized = part.state === "completed" && part.outcome === "authorized";
  const isCompleted = part.state === "completed";
  const Icon = isAuthorized ? CheckCircleIcon : isCompleted ? XCircleIcon : KeyRoundIcon;
  const instructions = part.authorization?.instructions;

  return (
    <Alert
      className={cn(
        isAuthorized
          ? "border-emerald-500/30 bg-emerald-500/5"
          : isCompleted
            ? "border-destructive/30 bg-destructive/5"
            : "border-blue-500/30 bg-blue-500/5",
      )}
    >
      <Icon className="size-4" />
      <AlertTitle>{authorizationTitle(part)}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <p>{authorizationDescription(part)}</p>
        {part.state === "required" && instructions && instructions !== part.description ? (
          <p>{instructions}</p>
        ) : null}
        {part.state === "required" && part.authorization?.userCode ? (
          <div className="flex items-center gap-2">
            <span>Code</span>
            <code className="rounded-md bg-background px-2 py-1 font-mono text-foreground">
              {part.authorization.userCode}
            </code>
          </div>
        ) : null}
        {part.state === "required" && part.authorization?.url ? (
          <Button asChild size="sm">
            <a href={part.authorization.url} rel="noreferrer" target="_blank">
              <ExternalLinkIcon className="size-3" />
              Authorize {part.displayName}
            </a>
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function authorizationTitle(part: EveAuthorizationPart): string {
  if (part.state === "required") {
    return `Authorization required · ${part.displayName}`;
  }
  return part.outcome === "authorized"
    ? `${part.displayName} connected`
    : `${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}`;
}

function authorizationDescription(part: EveAuthorizationPart): string {
  if (part.state === "required") {
    return part.description;
  }
  if (part.outcome === "authorized") {
    return `${part.displayName} connected.`;
  }
  const reason = part.reason ? ` (${part.reason})` : "";
  return `${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}${reason}.`;
}

function formatAuthorizationOutcome(outcome: NonNullable<EveAuthorizationPart["outcome"]>): string {
  return outcome === "timed-out" ? "timed out" : outcome;
}

function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "authorization":
      return `authorization:${part.turnId}:${part.stepIndex}:${part.name}`;
    case "dynamic-tool":
      return part.toolCallId;
    default:
      return `${part.type}:${index}`;
  }
}
