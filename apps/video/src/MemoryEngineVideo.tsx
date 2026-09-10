import React from "react";
import {
  AbsoluteFill,
  Easing,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig
} from "remotion";

const C = {
  bg: "#071018",
  panel: "#0c1822",
  panel2: "#102332",
  text: "#e8f2f4",
  muted: "#7f99a4",
  cyan: "#4ed6e8",
  green: "#4bd39b",
  amber: "#ffbd68",
  violet: "#b79aff",
  red: "#fb7b83",
  line: "#25414f"
};

type Point = { x: number; y: number };

export const MemoryEngineVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, color: C.text, fontFamily: "Inter, SF Pro Display, PingFang SC, sans-serif" }}>
      <Grid />
      <Sequence from={0} durationInFrames={150}>
        <Intro />
      </Sequence>
      <Sequence from={120} durationInFrames={300}>
        <IngestionScene />
      </Sequence>
      <Sequence from={390} durationInFrames={330}>
        <AdmissionScene />
      </Sequence>
      <Sequence from={690} durationInFrames={330}>
        <RetrievalScene />
      </Sequence>
      <Sequence from={990} durationInFrames={300}>
        <DreamingScene />
      </Sequence>
      <Sequence from={1230} durationInFrames={270}>
        <PackScene />
      </Sequence>
      <Footer frame={frame} fps={fps} />
    </AbsoluteFill>
  );
};

const Grid: React.FC = () => (
  <AbsoluteFill style={{ opacity: 0.24, backgroundImage: `linear-gradient(${C.line} 1px, transparent 1px), linear-gradient(90deg, ${C.line} 1px, transparent 1px)`, backgroundSize: "80px 80px", maskImage: "linear-gradient(to bottom, black, transparent 92%)" }} />
);

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const titleIn = spring({ frame, fps: 30, config: { damping: 200, stiffness: 120 } });
  const scan = interpolate(frame, [0, 150], [0, 1], { extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  return (
    <AbsoluteFill style={{ padding: "188px 160px" }}>
      <div style={{ color: C.cyan, fontSize: 24, letterSpacing: 6, fontWeight: 600, opacity: titleIn }}>NEXCORE / MEMORY SYSTEM</div>
      <div style={{ marginTop: 26, fontSize: 104, lineHeight: 1, fontWeight: 500, letterSpacing: -3, transform: `translateY(${interpolate(titleIn, [0, 1], [36, 0])}px)`, opacity: titleIn }}>CONTEXT ENGINE</div>
      <div style={{ marginTop: 34, color: C.muted, fontSize: 34, opacity: interpolate(frame, [24, 75], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>让智能体记住可追溯的上下文</div>
      <div style={{ width: 620, height: 2, marginTop: 78, backgroundColor: C.line, overflow: "hidden" }}><div style={{ width: `${scan * 100}%`, height: "100%", backgroundColor: C.cyan }} /></div>
      <div style={{ marginTop: 18, color: C.muted, fontSize: 18, letterSpacing: 2 }}>EVIDENCE-FIRST · GRAPH-AWARE · AUDITABLE</div>
    </AbsoluteFill>
  );
};

const SceneShell: React.FC<{ eyebrow: string; title: string; children: React.ReactNode }> = ({ eyebrow, title, children }) => {
  const frame = useCurrentFrame();
  const inP = spring({ frame, fps: 30, config: { damping: 200, stiffness: 100 } });
  return (
    <AbsoluteFill style={{ padding: "104px 120px", opacity: inP, transform: `translateY(${interpolate(inP, [0, 1], [24, 0])}px)` }}>
      <div style={{ color: C.cyan, fontSize: 18, letterSpacing: 4, fontWeight: 600 }}>{eyebrow}</div>
      <div style={{ marginTop: 16, fontSize: 48, fontWeight: 500, letterSpacing: -1 }}>{title}</div>
      {children}
    </AbsoluteFill>
  );
};

const IngestionScene: React.FC = () => {
  const frame = useCurrentFrame();
  const pulse = interpolate(frame % 90, [0, 45, 90], [0, 1, 0], { easing: Easing.inOut(Easing.quad) });
  const nodes = [
    { x: 90, label: "Agent / Connector", sub: "MemoryEvent", color: C.cyan },
    { x: 400, label: "Data Lake", sub: "raw + parsed evidence", color: C.green },
    { x: 710, label: "Fact Fusion", sub: "FactItem + SourceRef", color: C.amber },
    { x: 1020, label: "STM Admission", sub: "rules + provenance", color: C.violet }
  ];
  return <SceneShell eyebrow="01 / INGESTION" title="先保留证据，再生成记忆"><div style={{ marginTop: 66, display: "flex", alignItems: "center", gap: 0 }}>{nodes.map((node, index) => <React.Fragment key={node.label}><TechNode x={node.x} label={node.label} sub={node.sub} color={node.color} active={pulse > .42 && pulse < .8} /><Arrow x={node.x + 230} y={112} visible={index < nodes.length - 1} /></React.Fragment>)}</div><div style={{ display: "flex", gap: 20, marginTop: 54 }}><CodePanel title="MemoryEvent" lines={["eventType: conversation", "eventTime: 2026-08-07T14:22", "sourceRef: feishu://doc/…", "permissionSnapshot: captured"]} accent={C.cyan} /><CodePanel title="FactItem" lines={["factType: preference", "normalizedClaim: concise_answer", "confidence: high", "linkedSegments: 3"]} accent={C.amber} /><CodePanel title="audit trail" lines={["idempotencyKey ✓", "raw event ✓", "unsupported → pending", "replayable ✓"]} accent={C.green} /></div></SceneShell>;
};

const AdmissionScene: React.FC = () => {
  const frame = useCurrentFrame();
  const active = Math.min(6, Math.floor(frame / 32));
  const signals = ["importance", "confidence", "freshness", "sensitivity", "actor weight", "conflict", "permission"];
  const scoreBySignal = [92, 86, 78, 30, 72, 88, 100] as const;
  return <SceneShell eyebrow="02 / ADMISSION" title="STM 准入：一条可解释的记忆门控"><div style={{ display: "flex", gap: 84, marginTop: 56, alignItems: "center" }}><div style={{ width: 610 }}><div style={{ display: "grid", gap: 16 }}>{signals.map((signal, index) => <SignalBar key={signal} label={signal} value={index <= active ? scoreBySignal[index] ?? 0 : 0} color={index === 3 ? C.red : C.cyan} />)}</div></div><div style={{ position: "relative", width: 460, height: 340, display: "grid", placeItems: "center" }}><div style={{ position: "absolute", width: 310, height: 310, borderRadius: "50%", border: `1px solid ${C.line}`, transform: `rotate(${frame * .3}deg)` }} /><div style={{ position: "absolute", width: 218, height: 218, borderRadius: "50%", border: `1px dashed ${C.line}`, transform: `rotate(${-frame * .5}deg)` }} /><div style={{ width: 170, height: 170, borderRadius: 18, border: `1px solid ${C.violet}`, backgroundColor: C.panel2, display: "grid", placeItems: "center", textAlign: "center", boxShadow: `0 0 36px ${C.violet}40` }}><div><div style={{ color: C.violet, fontSize: 18, letterSpacing: 2 }}>STM</div><div style={{ marginTop: 8, fontSize: 14, color: C.muted }}>active memory</div><div style={{ marginTop: 20, fontSize: 24 }}>ADMIT</div></div></div></div></div><div style={{ marginTop: 40, color: C.muted, fontSize: 20 }}>高敏内容进入 <span style={{ color: C.red }}>rejected / pending_confirm</span>，而不是静默写入。</div></SceneShell>;
};

const RetrievalScene: React.FC = () => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, 180], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const points: Point[] = [{ x: 860, y: 210 }, { x: 1010, y: 150 }, { x: 1150, y: 260 }, { x: 1270, y: 160 }, { x: 1060, y: 360 }, { x: 1220, y: 390 }, { x: 900, y: 420 }];
  const rootPoint = points[0] as Point;
  return <SceneShell eyebrow="03 / RETRIEVAL" title="图谱内混合检索，让召回看见关系"><div style={{ display: "flex", gap: 80, marginTop: 52 }}><div style={{ width: 470 }}><div style={{ color: C.muted, fontSize: 16, marginBottom: 20 }}>query → candidate ranking</div>{[["FTS", .86, "关键词"], ["Vector", .78, "语义相似"], ["Graph", .64, "关系邻域"], ["Time", .52, "时序"], ["Feedback", .38, "使用反馈"]].map(([label, value, note]) => <div key={label as string} style={{ marginBottom: 20 }}><div style={{ display: "flex", justifyContent: "space-between", color: C.muted, fontSize: 14 }}><span>{label as string}</span><span>{(value as number).toFixed(2)} · {note as string}</span></div><div style={{ height: 10, marginTop: 7, backgroundColor: C.panel2, borderRadius: 5, overflow: "hidden" }}><div style={{ width: `${(value as number) * progress * 100}%`, height: "100%", backgroundColor: C.cyan }} /></div></div>)}</div><div style={{ position: "relative", width: 690, height: 400 }}>{points.map((point, index) => <React.Fragment key={`${point.x}-${point.y}`}><div style={{ position: "absolute", left: point.x - 800, top: point.y - 40, width: 18, height: 18, borderRadius: "50%", backgroundColor: index === 0 ? C.amber : C.cyan, boxShadow: `0 0 20px ${index === 0 ? C.amber : C.cyan}88` }} />{index > 0 && <svg style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }} width="690" height="400"><line x1={rootPoint.x - 800 + 9} y1={rootPoint.y - 40 + 9} x2={point.x - 800 + 9} y2={point.y - 40 + 9} stroke={C.line} strokeWidth="1" strokeDasharray="4 8" /></svg>}</React.Fragment>)}<div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "18px 22px", border: `1px solid ${C.green}`, backgroundColor: C.panel, boxShadow: `0 0 30px ${C.green}26` }}><div style={{ color: C.green, fontSize: 14, letterSpacing: 2 }}>CONTEXT PACK</div><div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>{["profile", "task", "recent", "constraints", "citations", "conflicts"].map((item) => <span key={item} style={{ border: `1px solid ${C.line}`, padding: "6px 10px", color: C.text, fontSize: 12 }}>{item}</span>)}</div></div></div></div></SceneShell>;
};

const DreamingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, 240], [0, 1], { extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  return <SceneShell eyebrow="04 / DREAMING" title="后台巩固，不打断前台交互"><div style={{ display: "flex", alignItems: "center", gap: 80, marginTop: 72 }}><div style={{ width: 330, height: 240, border: `1px solid ${C.violet}`, backgroundColor: C.panel, padding: 26 }}><div style={{ color: C.violet, fontSize: 16, letterSpacing: 2 }}>DREAMING RUN</div><div style={{ marginTop: 34, fontSize: 28 }}>23:00</div><div style={{ marginTop: 12, color: C.muted, fontSize: 15 }}>Asia / Shanghai</div><div style={{ marginTop: 30, height: 5, backgroundColor: C.panel2 }}><div style={{ width: `${progress * 100}%`, height: "100%", backgroundColor: C.violet }} /></div><div style={{ marginTop: 10, color: C.muted, fontSize: 12 }}>checkpoint · resumable · single STM</div></div><div style={{ width: 390, textAlign: "center" }}><div style={{ fontSize: 22, color: C.muted }}>STM</div><div style={{ margin: "14px auto", width: 180, height: 1, backgroundColor: C.line }} /><div style={{ width: 174, height: 174, margin: "0 auto", borderRadius: "50%", border: `1px solid ${C.amber}`, display: "grid", placeItems: "center", transform: `rotate(${frame * .2}deg)` }}><div style={{ transform: `rotate(${-frame * .2}deg)`, color: C.amber, fontSize: 17, letterSpacing: 2 }}>EVALUATE</div></div><div style={{ margin: "14px auto", width: 180, height: 1, backgroundColor: C.line }} /><div style={{ fontSize: 22, color: C.green }}>LTM</div></div><div style={{ width: 330, height: 240, border: `1px solid ${C.green}`, backgroundColor: C.panel, padding: 26 }}><div style={{ color: C.green, fontSize: 16, letterSpacing: 2 }}>OUTCOME</div><div style={{ marginTop: 28, display: "grid", gap: 14, color: C.muted, fontSize: 14 }}><div><span style={{ color: C.green }}>consolidate</span> → create LTM</div><div><span style={{ color: C.amber }}>observe</span> → next_evaluate_at</div><div><span style={{ color: C.red }}>drop</span> → release STM</div></div></div></div></SceneShell>;
};

const PackScene: React.FC = () => {
  const frame = useCurrentFrame();
  const reveal = (index: number) => interpolate(frame, [index * 22, index * 22 + 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const chips = ["profile", "task", "recent", "constraints", "citations", "conflicts"];
  return <SceneShell eyebrow="05 / ASSEMBLY" title="最终输出：有证据、有限额、可解释的 Context Pack"><div style={{ display: "flex", gap: 120, alignItems: "center", marginTop: 58 }}><div style={{ width: 440 }}><div style={{ color: C.muted, fontSize: 16, marginBottom: 16 }}>预算分配 / 600 tokens</div><div style={{ height: 34, display: "flex", overflow: "hidden", border: `1px solid ${C.line}` }}>{[["profile", 18, C.violet], ["task", 26, C.cyan], ["recent", 22, C.green], ["constraints", 16, C.amber], ["citations", 10, C.cyan], ["conflicts", 8, C.red]].map(([name, value, color]) => <div key={name as string} style={{ width: `${value as number}%`, backgroundColor: color as string, opacity: .86, borderRight: `1px solid ${C.bg}` }} />)}</div><div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginTop: 24 }}>{chips.map((chip, index) => <div key={chip} style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", borderBottom: `1px solid ${C.line}`, opacity: reveal(index) }}><span>{chip}</span><span style={{ color: C.muted }}>{[108, 156, 132, 96, 60, 48][index]}t</span></div>)}</div></div><div style={{ width: 490, minHeight: 330, border: `1px solid ${C.cyan}`, backgroundColor: C.panel, padding: 28, boxShadow: `0 0 42px ${C.cyan}24`, opacity: reveal(2) }}><div style={{ color: C.cyan, fontSize: 15, letterSpacing: 3 }}>R2 / ASSEMBLE_CONTEXT</div><div style={{ marginTop: 26, color: C.text, fontSize: 22, lineHeight: 1.5 }}>“回答要短，但要给验证证据。”</div><div style={{ marginTop: 24, display: "grid", gap: 10, color: C.muted, fontSize: 14 }}><div>✓ sourceRef → 可回链</div><div>✓ conflicts → 不静默合并</div><div>✓ dropped reasons → 可解释</div></div><div style={{ marginTop: 30, paddingTop: 14, borderTop: `1px solid ${C.line}`, color: C.green, fontSize: 13 }}>ready for agent consumption</div></div></div></SceneShell>;
};

const TechNode: React.FC<{ x: number; label: string; sub: string; color: string; active: boolean }> = ({ x, label, sub, color, active }) => <div style={{ position: "relative", width: 230, height: 130, border: `1px solid ${color}`, backgroundColor: C.panel, padding: 20, boxShadow: active ? `0 0 24px ${color}66` : "none" }}><div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: color, boxShadow: `0 0 14px ${color}` }} /><div style={{ marginTop: 18, fontSize: 20 }}>{label}</div><div style={{ marginTop: 8, color: C.muted, fontSize: 13 }}>{sub}</div></div>;

const Arrow: React.FC<{ x: number; y: number; visible: boolean }> = ({ x, y, visible }) => <div style={{ width: 80, height: 1, backgroundColor: visible ? C.line : "transparent", position: "relative" }}><div style={{ position: "absolute", right: 0, top: -4, width: 0, height: 0, borderTop: "5px solid transparent", borderBottom: "5px solid transparent", borderLeft: `7px solid ${visible ? C.line : "transparent"}` }} /></div>;

const CodePanel: React.FC<{ title: string; lines: string[]; accent: string }> = ({ title, lines, accent }) => <div style={{ width: 360, minHeight: 142, border: `1px solid ${C.line}`, backgroundColor: C.panel, padding: "18px 20px" }}><div style={{ color: accent, fontSize: 13, letterSpacing: 2 }}>{title}</div><div style={{ marginTop: 14, display: "grid", gap: 6, color: C.muted, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>{lines.map((line) => <div key={line}>{line}</div>)}</div></div>;

const SignalBar: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => <div><div style={{ display: "flex", justifyContent: "space-between", color: C.muted, fontSize: 14 }}><span>{label}</span><span>{value ? `${value}/100` : "evaluating"}</span></div><div style={{ height: 10, marginTop: 7, backgroundColor: C.panel2, overflow: "hidden" }}><div style={{ width: `${value}%`, height: "100%", backgroundColor: color, transition: "width 160ms linear" }} /></div></div>;

const Footer: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => <div style={{ position: "absolute", left: 120, right: 120, bottom: 42, display: "flex", justifyContent: "space-between", color: C.muted, fontSize: 13, letterSpacing: 1 }}><span>NEXCORE CONTEXT ENGINE</span><span>{String(Math.floor(frame / fps)).padStart(2, "0")}s / 50s</span></div>;
