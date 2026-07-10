import { AgentConnectionForm } from "@/components/agent-connection-form";
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
    </section>
  );
}
