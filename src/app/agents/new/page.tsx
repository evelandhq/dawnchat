import { AgentConnectionForm } from "@/components/agent-connection-form";
import { AgentDiscovery } from "@/components/agent-discovery";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function NewAgentPage(): React.ReactElement {
  return (
    <section className="mx-auto w-full max-w-xl space-y-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold tracking-tight">Connect an agent</h1>
          </CardTitle>
          <CardDescription>Register and verify a remote Eve agent.</CardDescription>
        </CardHeader>
        <CardContent>
          <AgentConnectionForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-xl font-semibold tracking-tight">Discover from a gateway</h2>
          </CardTitle>
          <CardDescription>List the agents running behind an Eve gateway and connect them in one click.</CardDescription>
        </CardHeader>
        <CardContent>
          <AgentDiscovery />
        </CardContent>
      </Card>
    </section>
  );
}
