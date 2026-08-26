"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { ChevronRightIcon, TerminalIcon, WrenchIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalTitle,
} from "./terminal";

const compactCodeBlockClassName =
  "rounded-none border-0 bg-transparent [&_pre]:!bg-transparent [&_pre]:px-3 [&_pre]:pt-2 [&_pre]:pb-3 [&_pre]:text-xs [&_code]:text-xs";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group not-prose w-full", className)} {...props} />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

/**
 * Tool states plus `input-dismissed`: an input request the agent stopped
 * waiting on without any recorded answer. AI SDK has no state for it because
 * it is an Eve HITL outcome, not a tool lifecycle step.
 */
export type ToolStatus = ToolPart["state"] | "input-dismissed";

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | {
      type: ToolUIPart["type"];
      state: ToolUIPart["state"] | "input-dismissed";
      toolName?: never;
    }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"] | "input-dismissed";
      toolName: string;
    }
);

const statusLabels: Record<ToolStatus, string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-dismissed": "Dismissed",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

export const getStatusIndicator = (status: ToolStatus): ReactNode =>
  status === "output-available" ? null : (
    <span
      className={cn(
        "text-xs",
        (status === "output-error" || status === "output-denied") &&
          "text-destructive",
      )}
    >
      {statusLabels[status]}
    </span>
  );

/** Kept for other AI Elements that consume the shared tool lifecycle UI. */
export const getStatusBadge = getStatusIndicator;

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const displayName = title ?? derivedName;
  const Icon = displayName.toLowerCase() === "bash" ? TerminalIcon : WrenchIcon;

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 rounded-sm py-0.5 text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    >
      <Icon className="size-4 shrink-0" />
      <span className="text-sm">{displayName}</span>
      {getStatusIndicator(state)}
      <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "flex flex-col gap-3 py-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-2",
      className,
    )}
    {...props}
  />
);

export type BashToolContentProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const BashToolContent = ({
  className,
  input,
  output,
  errorText,
  ...props
}: BashToolContentProps) => {
  const command = getRecordValue(input, "command");
  const stdout =
    getRecordValue(output, "stdout") ??
    (typeof output === "string" ? output : "");
  const stderr = getRecordValue(output, "stderr") ?? errorText ?? "";
  const exitCode = getRecordValue(output, "exitCode");
  const hasResult = Boolean(
    stdout || stderr || (typeof exitCode === "number" && exitCode !== 0),
  );
  const transcript = [
    `$ ${command ?? "…"}`,
    stdout ? String(stdout).trimEnd() : undefined,
    stderr ? String(stderr).trimEnd() : undefined,
    typeof exitCode === "number" && exitCode !== 0
      ? `Exited with code ${exitCode}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  return (
    <div className={className} {...props}>
      <Terminal className="rounded-md" output={transcript}>
        <TerminalHeader className="px-3 py-1.5">
          <TerminalTitle>Shell</TerminalTitle>
          <TerminalActions>
            <TerminalCopyButton aria-label="Copy terminal transcript" />
          </TerminalActions>
        </TerminalHeader>
        <TerminalContent className="max-h-80 p-3 text-xs leading-relaxed">
          <pre className="flex flex-col whitespace-pre-wrap break-words">
            <span>{`$ ${command ?? "…"}`}</span>
            {hasResult ? (
              <>
                {stdout ? <span>{String(stdout).trimEnd()}</span> : null}
                {stderr ? (
                  <span className="text-destructive">{String(stderr).trimEnd()}</span>
                ) : null}
                {typeof exitCode === "number" && exitCode !== 0 ? (
                  <span className="text-muted-foreground">
                    Exited with code {exitCode}
                  </span>
                ) : null}
              </>
            ) : null}
          </pre>
        </TerminalContent>
      </Terminal>
    </div>
  );
};

const getRecordValue = (
  value: unknown,
  key: string,
): string | number | undefined => {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];
  return typeof property === "string" || typeof property === "number"
    ? property
    : undefined;
};

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div
    className={cn("overflow-hidden rounded-md bg-muted/50", className)}
    {...props}
  >
    <span className="block px-3 pt-3 font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
      Parameters
    </span>
    <CodeBlock
      className={compactCodeBlockClassName}
      code={JSON.stringify(input, null, 2)}
      language="json"
    />
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (output === undefined && !errorText) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock
        className={compactCodeBlockClassName}
        code={JSON.stringify(output, null, 2)}
        language="json"
      />
    );
  } else if (typeof output === "string") {
    Output = (
      <CodeBlock
        className={compactCodeBlockClassName}
        code={output}
        language="json"
      />
    );
  } else if (output !== undefined) {
    Output = (
      <CodeBlock
        className={compactCodeBlockClassName}
        code={JSON.stringify(output)}
        language="json"
      />
    );
  }

  return (
    <div
      className={cn(
        "overflow-x-auto rounded-md text-xs [&_table]:w-full",
        errorText
          ? "bg-destructive/10 text-destructive"
          : "bg-muted/50 text-foreground",
        className,
      )}
      {...props}
    >
      <span className="block px-3 pt-3 font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </span>
      {errorText ? <div className="px-3 pt-2 pb-3">{errorText}</div> : null}
      {Output}
    </div>
  );
};
