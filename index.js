const blacklist = new Map();
const TTL = 10 * 60 * 1000; // 10 MINUTOS

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();

    // Limpieza agresiva de memoria
    for (let [id, time] of blacklist) {
      if (now - time > TTL) blacklist.delete(id);
    }

    if (request.method === "POST" && url.pathname === "/burn") {
      try {
        const { jobId } = await request.json();
        if (jobId) {
          blacklist.set(jobId, now);
          return new Response(JSON.stringify({ status: "Burnt", count: blacklist.size }), {
            headers: { "Content-Type": "application/json" }
          });
        }
      } catch (e) { return new Response("Error", { status: 400 }); }
    }

    if (url.pathname === "/list") {
      const data = Array.from(blacklist.keys());
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("READY 🟢", { status: 200 });
  }
};
