import { agentAuthMethodDescriptors } from "@/eve/auth-methods";

export async function GET(): Promise<Response> {
  return Response.json({ methods: agentAuthMethodDescriptors });
}
