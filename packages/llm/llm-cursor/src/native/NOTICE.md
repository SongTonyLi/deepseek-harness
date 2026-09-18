# Vendored Cursor `agent.v1` schema

`agent_pb.ts` is the MIT-licensed Connect/protobuf schema published by the
community Cursor client at https://github.com/Rahularya01/pi-cursor
(copyright 2026 Rahul Arya). DeepSeek Harness vendors the generated TypeScript
so this adapter can speak Cursor's unofficial `agent.v1` wire without a
runtime dependency on that package.

The Cursor integration is unofficial. Cursor may change auth URLs, headers, or
the proto without notice.
