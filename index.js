// cloudflare
// blossom api

const blacklist = new Map();
const TTL = 10 * 60 * 1000; // 10 MINUTOS EXACTOS

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const now = Date.now();

    // passive cleaning
    for (let [id, time] of blacklist) {
      if (now - time > TTL) blacklist.delete(id);
    }

    // burning ids
    if (request.method === "POST" && url.pathname === "/burn") {
      try {
        const { jobId } = await request.json();
        if (jobId) {
          blacklist.set(jobId, now);
          return new Response(JSON.stringify({ status: "Burnt", id: jobId }), {
            headers: { "Content-Type": "application/json" },
            status: 200
          });
        }
      } catch (e) {
        return new Response("Invalid JSON", { status: 400 });
      }
    }

    // obtain list
    if (url.pathname === "/list") {
      const listArray = Array.from(blacklist.keys());
      return new Response(JSON.stringify(listArray), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    }

    return new Response("blossom working 🟢", { status: 200 });
  },
};
