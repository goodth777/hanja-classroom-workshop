import { createHanjaServer } from "./app.js";

const port = Number(process.env.PORT ?? 4000);
const { httpServer } = createHanjaServer();

httpServer.listen(port, () => {
  console.log(`Hanja realtime server listening on http://localhost:${port}`);
});
