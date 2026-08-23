'use client';

import type { FileUIPart } from 'ai';
import { AlertCircleIcon, CornerDownLeftIcon, ListEndIcon, Trash2Icon } from 'lucide-react';

import { PromptInputHeader } from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export type QueuedTurn = {
  id: string;
  message: {
    files: FileUIPart[];
    text: string;
  };
  status: 'failed' | 'queued' | 'sending';
  dispatchPolicy?: 'queue' | 'steer';
  error?: string;
};

type ChatSteerQueueProps = {
  dispatchBlocked: boolean;
  onDelete: (id: string) => void;
  onDispatch: (id: string) => void;
  turns: QueuedTurn[];
};

export function ChatSteerQueue({
  dispatchBlocked,
  onDelete,
  onDispatch,
  turns,
}: ChatSteerQueueProps): React.ReactElement | null {
  if (turns.length === 0) return null;

  return (
    <PromptInputHeader className="block cursor-default border-b p-0 text-foreground select-text">
      <ul aria-label="Queued messages" className="w-full" role="list">
        {turns.map((turn, index) => {
          const label = queuedTurnLabel(turn);
          const sending = turn.status === 'sending';
          return (
            <li className="animate-in fade-in slide-in-from-bottom-1 duration-200" key={turn.id}>
              <div className="flex min-h-11 items-center gap-2 px-3 py-2">
                {turn.status === 'failed' ? (
                  <AlertCircleIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-destructive"
                  />
                ) : (
                  <ListEndIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-sm" title={label}>
                  {label}
                </span>
                {sending ? (
                  <span
                    aria-live="polite"
                    className="flex shrink-0 items-center gap-1.5 px-2 text-xs text-muted-foreground"
                  >
                    <Spinner className="size-3" />
                    {turn.dispatchPolicy === 'steer' ? 'Steering…' : 'Sending…'}
                  </span>
                ) : (
                  <Button
                    aria-label={
                      turn.status === 'failed'
                        ? `Retry queued message "${label}"`
                        : `Steer now with "${label}"`
                    }
                    disabled={dispatchBlocked}
                    onClick={() => onDispatch(turn.id)}
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    <CornerDownLeftIcon aria-hidden="true" data-icon="inline-start" />
                    {turn.status === 'failed' ? 'Retry' : 'Steer'}
                  </Button>
                )}
                {!sending ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label={`Delete queued message "${label}"`}
                        onClick={() => onDelete(turn.id)}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete queued message</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
              {index < turns.length - 1 ? <Separator /> : null}
            </li>
          );
        })}
      </ul>
    </PromptInputHeader>
  );
}

function queuedTurnLabel(turn: QueuedTurn): string {
  const text = turn.message.text.trim();
  if (text) return text;
  if (turn.message.files.length === 1) {
    return turn.message.files[0]?.filename || 'Attachment';
  }
  return `${turn.message.files.length} attachments`;
}
