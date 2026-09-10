import { Composition, registerRoot } from "remotion";
import { MemoryEngineVideo } from "./MemoryEngineVideo";

export const RemotionRoot = () => (
  <Composition
    id="MemoryEngineDemo"
    component={MemoryEngineVideo}
    durationInFrames={1500}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{}}
  />
);

registerRoot(RemotionRoot);
