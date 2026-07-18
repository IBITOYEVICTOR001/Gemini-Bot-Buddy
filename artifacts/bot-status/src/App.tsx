import { useEffect, useState } from 'react';

function usePulse() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % 3), 600);
    return () => clearInterval(id);
  }, []);
  return frame;
}

export default function App() {
  const frame = usePulse();
  const dots = '.'.repeat(frame + 1).padEnd(3, '\u00A0');
  const uptime = useUptime();

  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col items-center justify-center px-4 font-mono">
      {/* Glow orb */}
      <div className="relative mb-10">
        <div className="w-24 h-24 rounded-full bg-emerald-500/20 flex items-center justify-center ring-4 ring-emerald-500/30 shadow-[0_0_60px_rgba(16,185,129,0.35)]">
          <div className="w-10 h-10 rounded-full bg-emerald-400 shadow-[0_0_20px_rgba(52,211,153,0.8)]" />
        </div>
        <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 text-xs text-emerald-400 tracking-widest uppercase">
          online
        </span>
      </div>

      {/* Title */}
      <h1 className="text-3xl font-bold tracking-tight text-white mb-1">
        Telegram AI Bot
      </h1>
      <p className="text-sm text-slate-400 mb-10">
        Powered by Groq · LLaMA 3.3 70B
      </p>

      {/* Status card */}
      <div className="w-full max-w-sm bg-[#161b22] border border-white/10 rounded-2xl p-6 space-y-4 shadow-xl">
        <Row label="Status" value={<span className="text-emerald-400">Running{dots}</span>} />
        <Divider />
        <Row label="Polling" value="Long poll · active" />
        <Row label="Uptime" value={uptime} />
        <Row label="Memory" value="Per-user · 10 turns" />
        <Divider />
        <Row label="Model" value="llama-3.3-70b-versatile" />
        <Row label="Provider" value="Groq API" />
      </div>

      <p className="mt-10 text-xs text-slate-600">
        Send a message on Telegram to start chatting.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200">{value}</span>
    </div>
  );
}

function Divider() {
  return <div className="border-t border-white/5" />;
}

function useUptime() {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.floor((now - started) / 1000);
  const h = Math.floor(secs / 3600).toString().padStart(2, '0');
  const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}
