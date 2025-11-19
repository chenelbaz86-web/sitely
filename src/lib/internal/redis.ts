import { createClient } from "redis";

export const redis = await createClient({
  url: process.env.REDIS_URL,
})
  .on("error", (err) => console.log("Redis Client Error", err))
  .connect();

export const redisPublisher = await createClient({
  url: process.env.REDIS_URL,
})
  .on("error", (err) => console.log("Publisher Redis Client Error", err))
  .connect();
