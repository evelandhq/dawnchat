"use client";

import { useRef, useState } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AgentDeleteDialogProps = {
  agentId: string;
  agentName: string;
  redirectTo?: Route;
};

export function AgentDeleteDialog({
  agentId,
  agentName,
  redirectTo,
}: AgentDeleteDialogProps): React.ReactElement {
  const router = useRouter();
  const isDeletingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(nextOpen: boolean): void {
    if (isDeleting) {
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      setConfirmation("");
      setError(null);
    }
  }

  async function handleDelete(): Promise<void> {
    if (isDeletingRef.current) {
      return;
    }
    isDeletingRef.current = true;
    setIsDeleting(true);
    setError(null);
    try {
      const response = await fetch("/api/agents/" + agentId, {
        method: "DELETE",
      });
      if (!response.ok) {
        setError("Unable to delete agent. Please try again.");
        return;
      }

      setConfirmation("");
      setOpen(false);
      if (redirectTo) {
        router.push(redirectTo);
      } else {
        router.refresh();
      }
    } catch {
      setError("Unable to delete agent. Please try again.");
    } finally {
      isDeletingRef.current = false;
      setIsDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          aria-label={"Delete " + agentName}
        >
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!isDeleting}>
        <DialogHeader>
          <DialogTitle>Delete {agentName}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the agent and all of its chats, messages, and events.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={"delete-agent-" + agentId}>
            Type &quot;{agentName}&quot; to confirm
          </Label>
          <Input
            id={"delete-agent-" + agentId}
            value={confirmation}
            disabled={isDeleting}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={isDeleting}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={isDeleting || confirmation !== agentName}
            onClick={handleDelete}
          >
            {isDeleting ? "Deleting…" : "Delete agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
