export type FilterCameraCommand = {
  seq: number;
  type: "snap" | "start-recording" | "stop-recording";
};
export type FilterVideo =
  | { base64: string; mimeType: string; durationSeconds: number }
  | {
      uri: string;
      mimeType: string;
      durationSeconds: number;
      width: number;
      height: number;
      droppedFrames: number;
    };
export type FilterCameraProps = {
  filterId: string;
  dynamicFilters: { id: string; source: string }[];
  facing: "front" | "back";
  command: FilterCameraCommand | null;
  onPhoto: (photo: { base64: string; width: number; height: number }) => Promise<void>;
  onVideo: (video: FilterVideo) => Promise<void>;
  onCaptureError: (message: string) => Promise<void>;
};
