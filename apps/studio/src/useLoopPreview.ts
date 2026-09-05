import { useEffect, useRef, useState, type RefObject } from "react";
import { seconds, type TimeRange } from "./api.js";

interface LoopWindow {
  start: number;
  end: number;
}

export function useLoopPreview(videoRef: RefObject<HTMLVideoElement | null>) {
  const loopWindow = useRef<LoopWindow | undefined>(undefined);
  const [isLooping, setIsLooping] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const handleTimeUpdate = () => {
      const window = loopWindow.current;
      if (!window || video.currentTime < window.end) return;
      video.currentTime = window.start;
      void video.play().catch(() => undefined);
    };
    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => video.removeEventListener("timeupdate", handleTimeUpdate);
  }, [videoRef]);

  const startLoop = (range: TimeRange) => {
    const video = videoRef.current;
    if (!video) return;
    const start = Math.max(0, seconds(range.start) - 1.5);
    const end = seconds(range.start) + seconds(range.duration) + 1.5;
    loopWindow.current = { start, end };
    setIsLooping(true);
    video.currentTime = start;
    void video.play().catch(() => undefined);
  };

  const stopLoop = () => {
    loopWindow.current = undefined;
    setIsLooping(false);
  };

  return { isLooping, startLoop, stopLoop };
}
