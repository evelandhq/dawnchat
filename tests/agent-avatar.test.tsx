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

  it("passes custom classes through to the avatar root", () => {
    const { container } = render(
      React.createElement(AgentAvatar, {
        agentId: "agent_1",
        name: "Data Bot",
        size: "lg",
        className: "mt-2",
      }),
    );

    expect(container.querySelector('[data-slot="avatar"]')).toHaveClass("mt-2");
  });

  it("applies the size variant through the data-size attribute", () => {
    const { container } = render(
      React.createElement(AgentAvatar, { agentId: "agent_1", name: "Data Bot", size: "lg" }),
    );

    expect(container.querySelector('[data-slot="avatar"]')).toHaveAttribute("data-size", "lg");
  });
});
