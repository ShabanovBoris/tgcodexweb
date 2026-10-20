import { acquireGatewayLease } from "../../src/persistence/sqlite/GatewayLease";

const release = acquireGatewayLease(process.argv[2]);
process.stdout.write("locked\n");
try {
  await new Response(Bun.stdin.stream()).text();
} finally {
  release();
}
