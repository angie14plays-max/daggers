import express from "express";
import cors from "cors";
import Redis from "ioredis";

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL);

app.get("/", (req, res) => {
  res.send("Moderation API with Redis running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("API running on port", PORT);
});
