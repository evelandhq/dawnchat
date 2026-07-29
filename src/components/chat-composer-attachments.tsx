"use client";

import { PaperclipIcon } from "lucide-react";

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInputButton,
  PromptInputHeader,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";

export function ChatComposerAttachments(): React.ReactElement | null {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <PromptInputHeader>
      <Attachments variant="inline">
        {attachments.files.map((file) => (
          <Attachment data={file} key={file.id} onRemove={() => attachments.remove(file.id)}>
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

export function ChatAttachmentButton({ disabled }: { disabled: boolean }): React.ReactElement {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      aria-label="Attach files"
      disabled={disabled}
      onClick={attachments.openFileDialog}
      tooltip="Attach files"
    >
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  );
}
