import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AgentAvatar } from "@/components/agent-avatar";

describe("AgentAvatar", () => {
  it("renders the uppercased initial of the agent name", () => {
    render(React.createElement(AgentAvatar, { agentId: "agent_1", name: "data bot" }));
    expect(screen.getByText("D")).toBeInTheDocument();
  });

  it("shows an unreachable dot only when asked", () => {
    const { rerender } = render(
      React.createElement(AgentAvatar, { agentId: "agent_1", name: "Data Bot", showUnreachableDot: true }),
    );
    expect(screen.getByText("unreachable")).toBeInTheDocument();

    rerender(React.createElement(AgentAvatar, { agentId: "agent_1", name: "Data Bot" }));
    expect(screen.queryByText("unreachable")).not.toBeInTheDocument();
  });

  it("allows a custom dimension class to override the lg size", () => {
    const { container } = render(
      React.createElement(AgentAvatar, {
        agentId: "agent_1",
        name: "Data Bot",
        size: "lg",
        className: "size-16",
      }),
    );
    const avatar = container.querySelector('[data-slot="avatar"]');

    expect(avatar).toHaveClass("size-16");
    expect(avatar).not.toHaveClass("size-10");
    expect(avatar).not.toHaveClass("data-[size=lg]:size-10");
  });

  it("uses the lg dimension when no custom dimension is provided", () => {
    const { container } = render(
      React.createElement(AgentAvatar, { agentId: "agent_1", name: "Data Bot", size: "lg" }),
    );

    expect(container.querySelector('[data-slot="avatar"]')).toHaveClass("size-10");
  });
});
