"use client";

import { useState } from "react";
import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessageInputRequest,
  EveMessagePart,
} from "eve/react";
import type { InputResponse } from "eve/client";
import {
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
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;

type EveMessageViewProps = {
  canRespond: boolean;
  isStreaming: boolean;
  message: EveMessage;
  onInputResponses: (responses: readonly InputResponse[]) => void | Promise<void>;
};

export function EveMessageView({
  canRespond,
  isStreaming,
  message,
  onInputResponses,
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
            canRespond={canRespond}
            key={partKey(part, index)}
            onInputResponses={onInputResponses}
            part={part}
            showCaret={isStreaming && message.role === "assistant" && index === lastTextIndex}
          />
        ))}
      </MessageContent>
    </Message>
  );
}

function EveMessagePartView({
  canRespond,
  onInputResponses,
  part,
  showCaret,
}: {
  canRespond: boolean;
  onInputResponses: (responses: readonly InputResponse[]) => void | Promise<void>;
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
      return (
        <Tool defaultOpen={part.state === "approval-requested"}>
          <ToolHeader
            state={part.state}
            title={part.toolName}
            toolName={part.toolName}
            type="dynamic-tool"
          />
          <ToolContent>
            <ToolInput input={part.input} />
            <InputRequestPart
              canRespond={canRespond}
              onInputResponses={onInputResponses}
              part={part}
            />
            <ToolOutput errorText={part.errorText} output={part.output} />
          </ToolContent>
        </Tool>
      );
  }
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
  canRespond,
  onInputResponses,
  part,
}: {
  canRespond: boolean;
  onInputResponses: (responses: readonly InputResponse[]) => void | Promise<void>;
  part: EveDynamicToolPart;
}): React.ReactElement | null {
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  if (!inputRequest) {
    return null;
  }

  const inputResponse = part.toolMetadata?.eve?.inputResponse;
  const selectedOption = inputRequest.options?.find(
    (option) => option.id === inputResponse?.optionId,
  );

  return (
    <Confirmation approval={confirmationApproval(part)} state={part.state}>
      <ConfirmationTitle>{inputRequest.prompt}</ConfirmationTitle>
      <ConfirmationRequest>
        <InputRequestControls
          canRespond={canRespond}
          inputRequest={inputRequest}
          onInputResponses={onInputResponses}
        />
      </ConfirmationRequest>
      {inputResponse ? (
        <p className="text-sm font-medium">
          Responded: {selectedOption?.label ?? inputResponse.text ?? inputResponse.optionId}
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
  inputRequest,
  onInputResponses,
}: {
  canRespond: boolean;
  inputRequest: EveMessageInputRequest;
  onInputResponses: (responses: readonly InputResponse[]) => void | Promise<void>;
}): React.ReactElement {
  const [text, setText] = useState("");
  const acceptsText =
    inputRequest.display === "text" ||
    inputRequest.allowFreeform === true ||
    (inputRequest.options?.length ?? 0) === 0;

  const submitText = (): void => {
    const response = text.trim();
    if (!response || !canRespond) {
      return;
    }
    void onInputResponses([{ requestId: inputRequest.requestId, text: response }]);
  };

  return (
    <div className="flex flex-col gap-3 pt-2">
      {inputRequest.options?.length ? (
        <ConfirmationActions className="self-start">
          {inputRequest.options.map((option) => (
            <ConfirmationAction
              disabled={!canRespond}
              key={option.id}
              onClick={() => {
                void onInputResponses([
                  { requestId: inputRequest.requestId, optionId: option.id },
                ]);
              }}
              variant={
                option.style === "danger"
                  ? "destructive"
                  : option.style === "primary"
                    ? "default"
                    : "outline"
              }
            >
              {option.label}
            </ConfirmationAction>
          ))}
        </ConfirmationActions>
      ) : null}
      {acceptsText ? (
        <div className="flex items-center gap-2">
          <Input
            aria-label="Response"
            disabled={!canRespond}
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitText();
              }
            }}
            placeholder="Type a response"
            value={text}
          />
          <Button disabled={!canRespond || text.trim().length === 0} onClick={submitText} size="sm">
            Continue
          </Button>
        </div>
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
