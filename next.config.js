/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  // The broker adapter, schedulers and mongoose all run in the Node runtime of
  // this same process (see server.js) — never bundle them for the edge.
  serverExternalPackages: ["mongoose", "ws", "node-schedule"],
};
