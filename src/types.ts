export type DemoStatus = {
  requestId: string;
  phase: "started" | "waiting" | "complete";
  message: string;
};

