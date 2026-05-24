import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useTransform } from 'framer-motion';
import { Layers, Sparkles, Zap, Wand2 } from 'lucide-react';
import burgerInputImage from '../assets/landing/burger-input.png';
import burgerOutputImage from '../assets/landing/burger-output.png';
import { useLandingMotion } from '../hooks/useLandingMotion';

const NAV_ITEMS = [
  { href: '#features', label: 'Features' },
  { href: '#showcase', label: 'Showcase' },
  { href: '#pricing', label: 'Pricing' },
];

const MotionDiv = motion.div;
const MotionSection = motion.section;
const MotionArticle = motion.article;
const MotionButton = motion.button;
const MotionSpan = motion.span;

function GenerativeGridCanvas({ cursorRef, smoothedCursorRef, reducedMotion }) {
  const canvasRef = useRef(null);
  const particlesRef = useRef([]);
  const trailRef = useRef([]);
  const lastSpawnRef = useRef({ x: -9999, y: -9999 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      return undefined;
    }

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(window.innerWidth * ratio);
      canvas.height = Math.floor(window.innerHeight * ratio);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    window.addEventListener('resize', resize);

    let frameId = null;
    const render = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const smooth = smoothedCursorRef.current;
      const current = cursorRef.current;

      context.clearRect(0, 0, width, height);

      const vignette = context.createRadialGradient(width * 0.5, height * 0.32, 80, width * 0.5, height * 0.5, height * 0.95);
      vignette.addColorStop(0, 'rgba(14, 22, 30, 0.35)');
      vignette.addColorStop(1, 'rgba(0, 0, 0, 0.95)');
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);

      const cell = 52;
      const offsetX = ((smooth.x - width / 2) * 0.024) % cell;
      const offsetY = ((smooth.y - height / 2) * 0.024) % cell;

      context.strokeStyle = 'rgba(102, 126, 145, 0.14)';
      context.lineWidth = 1;
      context.beginPath();
      for (let x = -cell; x <= width + cell; x += cell) {
        context.moveTo(x + offsetX, 0);
        context.lineTo(x + offsetX, height);
      }
      for (let y = -cell; y <= height + cell; y += cell) {
        context.moveTo(0, y + offsetY);
        context.lineTo(width, y + offsetY);
      }
      context.stroke();

      const auraA = context.createRadialGradient(width * 0.28, height * 0.24, 20, width * 0.28, height * 0.24, 350);
      auraA.addColorStop(0, 'rgba(29, 222, 203, 0.22)');
      auraA.addColorStop(1, 'rgba(29, 222, 203, 0)');
      context.fillStyle = auraA;
      context.fillRect(0, 0, width, height);

      const auraB = context.createRadialGradient(width * 0.74, height * 0.38, 20, width * 0.74, height * 0.38, 320);
      auraB.addColorStop(0, 'rgba(143, 124, 255, 0.16)');
      auraB.addColorStop(1, 'rgba(143, 124, 255, 0)');
      context.fillStyle = auraB;
      context.fillRect(0, 0, width, height);

      if (!reducedMotion) {
        trailRef.current.push({ x: smooth.x, y: smooth.y, life: 1 });
        if (trailRef.current.length > 24) {
          trailRef.current.shift();
        }

        const delta = Math.hypot(current.x - lastSpawnRef.current.x, current.y - lastSpawnRef.current.y);
        if (delta > 14) {
          lastSpawnRef.current = { ...current };
          for (let i = 0; i < 3; i += 1) {
            particlesRef.current.push({
              x: current.x + (Math.random() - 0.5) * 10,
              y: current.y + (Math.random() - 0.5) * 10,
              vx: (Math.random() - 0.5) * 1.1,
              vy: (Math.random() - 0.5) * 1.1,
              life: 1,
              hue: Math.random() > 0.45 ? 175 : 266,
              size: 1.3 + Math.random() * 2,
            });
          }
        }

        context.lineWidth = 1.2;
        for (let i = 1; i < trailRef.current.length; i += 1) {
          const prev = trailRef.current[i - 1];
          const point = trailRef.current[i];
          const alpha = i / trailRef.current.length;
          const gradient = context.createLinearGradient(prev.x, prev.y, point.x, point.y);
          gradient.addColorStop(0, `rgba(29, 222, 203, ${alpha * 0.25})`);
          gradient.addColorStop(1, `rgba(150, 130, 255, ${alpha * 0.2})`);
          context.strokeStyle = gradient;
          context.beginPath();
          context.moveTo(prev.x, prev.y);
          context.lineTo(point.x, point.y);
          context.stroke();
        }

        particlesRef.current = particlesRef.current.filter((particle) => particle.life > 0.05);
        particlesRef.current.forEach((particle) => {
          particle.x += particle.vx;
          particle.y += particle.vy;
          particle.life *= 0.95;
          context.fillStyle = particle.hue > 200
            ? `rgba(148, 130, 255, ${particle.life * 0.35})`
            : `rgba(29, 222, 203, ${particle.life * 0.42})`;
          context.beginPath();
          context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
          context.fill();
        });
      }

      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener('resize', resize);
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [cursorRef, reducedMotion, smoothedCursorRef]);

  return <canvas ref={canvasRef} className="pointer-events-none fixed inset-0 z-0" aria-hidden="true" />;
}

function NavLinkWithRay({ href, label }) {
  const [rayOffset, setRayOffset] = useState(0);

  return (
    <a
      href={href}
      className="group relative px-1 py-1 text-xs tracking-[0.24em] text-zinc-300/80 transition-colors hover:text-zinc-50"
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const pct = (event.clientX - bounds.left) / bounds.width;
        setRayOffset((pct - 0.5) * (bounds.width * 0.55));
      }}
    >
      <span className="relative z-10 [text-shadow:0_0_12px_rgba(190,210,220,0.22)]">{label}</span>
      <span
        className="pointer-events-none absolute -bottom-0.5 left-1/2 h-px w-12 -translate-x-1/2 rounded-full bg-gradient-to-r from-transparent via-cyan-200/90 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{ transform: `translateX(${rayOffset}px)` }}
      />
    </a>
  );
}

function BadgePill() {
  return (
    <div className="relative mb-12 inline-flex rounded-full p-px">
      <MotionDiv
        aria-hidden="true"
        className="absolute inset-0 rounded-full bg-[conic-gradient(from_10deg,#1DDECB,#84F6ED,#8F7CFF,#1DDECB)] opacity-90"
        animate={{ rotate: 360 }}
        transition={{ duration: 8.8, repeat: Infinity, ease: 'linear' }}
      />
      <div className="relative inline-flex items-center gap-2 rounded-full border border-white/12 bg-black/70 px-4 py-2 text-[0.7rem] tracking-[0.18em] text-zinc-100 uppercase backdrop-blur-md">
        <Sparkles className="h-3.5 w-3.5 text-cyan-300" strokeWidth={1.7} />
        <span className="badge-depth-text">AdReady 2.0 is now available</span>
      </div>
    </div>
  );
}

function ScrambleDemoButton({ reducedMotion }) {
  const baseText = 'Book a Demo';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const [display, setDisplay] = useState(baseText);
  const [isAnimating, setIsAnimating] = useState(false);

  const trigger = () => {
    if (reducedMotion || isAnimating) {
      setDisplay(baseText);
      return;
    }

    let frame = 0;
    setIsAnimating(true);
    const intervalId = window.setInterval(() => {
      frame += 1;
      const progress = frame / 10;
      const next = baseText
        .split('')
        .map((letter, index) => {
          if (letter === ' ') {
            return ' ';
          }
          return index < progress * baseText.length ? baseText[index] : chars[Math.floor(Math.random() * chars.length)];
        })
        .join('');
      setDisplay(next);

      if (frame >= 10) {
        window.clearInterval(intervalId);
        setDisplay(baseText);
        setIsAnimating(false);
      }
    }, 34);
  };

  return (
    <button
      type="button"
      onMouseEnter={trigger}
      className="group relative flex h-12 items-center justify-center overflow-hidden rounded-full border border-white/40 px-7 text-sm tracking-[0.14em] text-white transition-all duration-300 hover:border-transparent hover:bg-white/6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
    >
      <span className={`transition-all duration-200 ${isAnimating ? 'text-cyan-200 [text-shadow:0_0_14px_rgba(80,255,240,0.7)]' : ''}`}>
        {display}
      </span>
    </button>
  );
}

function ShowcasePanel({ heroDemo, reducedMotion, parallaxStyle }) {
  const xPct = Math.min(95, Math.max(5, (heroDemo.cursor.x / 640) * 100));
  const yPct = Math.min(92, Math.max(8, (heroDemo.cursor.y / 360) * 100));

  return (
    <MotionSection
      id="showcase"
      className="relative mx-auto mt-12 w-full max-w-6xl"
      style={parallaxStyle}
    >
      <div className="showcase-shell relative overflow-hidden rounded-[2rem] border border-white/10 bg-[linear-gradient(160deg,rgba(26,34,44,0.55),rgba(13,17,24,0.88))] p-3 shadow-[0_42px_120px_rgba(0,0,0,0.7)] backdrop-blur-xl">
        <div className="flex h-10 items-center gap-2 rounded-[1.4rem] border border-white/10 bg-black/55 px-4">
          <span className="h-2.5 w-2.5 rounded-full bg-[#FB7185]/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#FACC15]/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#34D399]/80" />
          <span className="ml-2 text-[0.62rem] uppercase tracking-[0.23em] text-zinc-400">Live AI Canvas</span>
        </div>

        <div className="relative mt-3 overflow-hidden rounded-[1.4rem] border border-white/10 bg-black/50 p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs tracking-[0.13em] text-zinc-300/80 uppercase">
            <span>{heroDemo.processing ? 'Processing in real-time' : 'Render pass complete'}</span>
            <span className="rounded-full border border-cyan-300/40 bg-cyan-300/10 px-3 py-1 text-[0.62rem] text-cyan-100">
              X: {heroDemo.cursor.x}px Y: {heroDemo.cursor.y}px
            </span>
          </div>
          <p className="mb-4 text-left text-[0.72rem] tracking-[0.15em] text-zinc-300/80 uppercase">
            Input image to AI-generated output
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="relative min-h-56 overflow-hidden rounded-2xl border border-white/10 bg-zinc-100/95">
              <img
                src={burgerInputImage}
                alt="Input product image"
                className="h-full w-full object-cover object-center"
              />
              <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/8" />
              <span className="absolute left-3 top-3 rounded-full border border-zinc-700/25 bg-white/85 px-2.5 py-1 text-[0.6rem] font-semibold uppercase tracking-[0.17em] text-zinc-900">
                Input Image
              </span>
            </div>
            <div className="relative min-h-56 overflow-hidden rounded-2xl border border-cyan-300/18 bg-zinc-950/60">
              <img
                src={burgerOutputImage}
                alt="Output branded ad creative"
                className="h-full w-full object-cover object-center"
              />
              <div className="absolute inset-0 bg-gradient-to-l from-black/4 via-transparent to-black/42" />
              <div
                className="absolute inset-y-0 left-0 bg-black/55"
                style={{ width: `${100 - heroDemo.progress * 100}%` }}
              />
              <div
                className="absolute inset-y-0 border-r border-cyan-300/90 shadow-[0_0_24px_rgba(29,222,203,0.55)]"
                style={{ left: `${heroDemo.progress * 100}%` }}
              />
              <span className="absolute left-3 top-3 rounded-full border border-cyan-200/30 bg-cyan-300/10 px-2.5 py-1 text-[0.6rem] font-semibold uppercase tracking-[0.17em] text-cyan-50">
                Output Image
              </span>
              <span className="absolute bottom-3 right-3 rounded-full border border-cyan-200/30 bg-black/45 px-2.5 py-1 text-[0.58rem] tracking-[0.14em] text-cyan-100 uppercase">
                Brand-ready creative
              </span>
            </div>
          </div>

          <div className="pointer-events-none absolute inset-0">
            <MotionDiv
              className="absolute z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-100/70 bg-cyan-200/30 shadow-[0_0_26px_rgba(29,222,203,0.8)]"
              animate={reducedMotion ? undefined : { scale: [1, 1.28, 1] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
              style={{ left: `${xPct}%`, top: `${yPct}%` }}
            >
              <span className="absolute left-1/2 top-full mt-1 block h-4 w-px -translate-x-1/2 bg-cyan-100/80" />
            </MotionDiv>
            {!reducedMotion && heroDemo.penPath.map((point, index) => {
              const alpha = (index + 1) / heroDemo.penPath.length;
              return (
                <span
                  key={`${point.t}-${index}`}
                  className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-200"
                  style={{
                    left: `${(point.x / 640) * 100}%`,
                    top: `${(point.y / 360) * 100}%`,
                    opacity: alpha * 0.45,
                    boxShadow: '0 0 10px rgba(80, 255, 242, 0.7)',
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </MotionSection>
  );
}

function FeatureCard({ accentClass, title, description, reducedMotion, widget }) {
  const [isHovered, setIsHovered] = useState(false);
  const [angles, setAngles] = useState({ x: 0, y: 0 });

  return (
    <MotionArticle
      className={`glass-feature-card group relative overflow-hidden rounded-[1.6rem] border border-white/12 bg-white/[0.03] p-8 ${accentClass}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        setAngles({ x: 0, y: 0 });
      }}
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;
        const rotateY = ((x / bounds.width) - 0.5) * 8;
        const rotateX = (0.5 - y / bounds.height) * 8;
        setAngles({ x: rotateX, y: rotateY });
      }}
      style={{
        transformStyle: 'preserve-3d',
        transform: reducedMotion ? undefined : `perspective(1000px) rotateX(${angles.x}deg) rotateY(${angles.y}deg) translateZ(0)`,
      }}
      whileHover={reducedMotion ? undefined : { y: -6 }}
      transition={{ type: 'spring', stiffness: 220, damping: 22 }}
    >
      <div className="pointer-events-none absolute -right-10 -top-8 h-44 w-44 rounded-full bg-gradient-to-br from-white/8 to-transparent blur-3xl" />
      <div className="relative z-10">
        {widget({ isHovered, reducedMotion })}
        <h3 className="mt-8 text-2xl font-semibold tracking-tight text-zinc-100">{title}</h3>
        <p className="mt-3 text-sm leading-relaxed text-zinc-300/84">{description}</p>
      </div>
    </MotionArticle>
  );
}

function PreciseControlWidget({ isHovered, reducedMotion }) {
  return (
    <div className="relative h-32 rounded-2xl border border-cyan-200/15 bg-black/35 p-3">
      <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(circle_at_25%_10%,rgba(29,222,203,0.25),transparent_70%)]" />
      <div className="relative mt-3 h-16" style={{ transformStyle: 'preserve-3d' }}>
        {[0, 1, 2].map((layer) => (
          <MotionDiv
            key={layer}
            className="absolute left-1/2 top-1/2 h-8 w-28 -translate-x-1/2 -translate-y-1/2 rounded-md border border-cyan-200/45 bg-cyan-300/8"
            animate={reducedMotion ? undefined : {
              y: isHovered ? -layer * 11 : -layer * 4,
              x: isHovered ? layer * 8 : 0,
              opacity: 1 - layer * 0.12,
            }}
            transition={{ type: 'spring', stiffness: 220, damping: 20 }}
            style={{ boxShadow: 'inset 0 0 18px rgba(29, 222, 203, 0.14)' }}
          />
        ))}
      </div>
      <MotionDiv
        className="absolute bottom-2 right-2 rounded-md border border-cyan-100/35 bg-black/70 px-2 py-1 text-[0.62rem] tracking-[0.13em] text-cyan-100"
        animate={isHovered && !reducedMotion ? { opacity: 1, y: 0 } : { opacity: 0.3, y: 4 }}
      >
        Anchor 48, 112
      </MotionDiv>
      <Layers className="absolute left-3 top-3 h-4 w-4 text-cyan-200" strokeWidth={1.5} />
    </div>
  );
}

function SmartGenerationWidget({ isHovered, reducedMotion }) {
  return (
    <div className="relative h-32 rounded-2xl border border-blue-200/20 bg-black/35 p-3">
      <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(circle_at_70%_20%,rgba(80,150,255,0.22),transparent_70%)]" />
      <MotionDiv
        className="absolute right-3 top-2"
        animate={reducedMotion ? undefined : { rotate: isHovered ? 40 : 0 }}
        transition={{ duration: 1.5, repeat: isHovered ? Infinity : 0, ease: 'linear' }}
      >
        <Sparkles className="h-5 w-5 text-blue-200" strokeWidth={1.5} />
      </MotionDiv>
      <div className="relative mt-5 overflow-hidden rounded-lg border border-blue-200/20 bg-zinc-900/70">
        <div className="h-16 w-full bg-[linear-gradient(90deg,#111827_0%,#202938_48%,#17202B_100%)]" />
        <MotionDiv
          className="absolute inset-y-0 left-0 bg-cyan-300/18"
          animate={reducedMotion ? { width: '65%' } : { width: ['18%', '82%', '48%'] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
        />
        <div className="pointer-events-none absolute inset-0">
          {[0, 1, 2, 3, 4, 5].map((dot) => (
            <MotionSpan
              key={dot}
              className="absolute h-1 w-1 rounded-full bg-blue-100"
              style={{ left: `${12 + dot * 14}%`, top: `${35 + (dot % 2) * 18}%` }}
              animate={reducedMotion ? undefined : { opacity: [0.2, 1, 0.2], y: [0, -4, 0] }}
              transition={{ duration: 1.2, delay: dot * 0.1, repeat: Infinity }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function LightningFastWidget({ isHovered, reducedMotion }) {
  return (
    <div className="relative h-32 rounded-2xl border border-violet-200/20 bg-black/35 p-3">
      <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(circle_at_40%_22%,rgba(170,120,255,0.22),transparent_72%)]" />
      <div className="flex items-center justify-between">
        <MotionDiv
          animate={reducedMotion ? undefined : { rotate: isHovered ? [0, -12, 10, 0] : 0, scale: isHovered ? [1, 1.12, 1] : 1 }}
          transition={{ duration: 0.62, repeat: isHovered ? Infinity : 0, repeatDelay: 1.4 }}
        >
          <Zap className="h-5 w-5 text-violet-200" strokeWidth={1.6} />
        </MotionDiv>
        <div className="w-20 space-y-1">
          {[40, 62, 88].map((width, index) => (
            <MotionDiv
              key={width}
              className="h-1.5 rounded-full bg-violet-300/70"
              animate={reducedMotion ? { width: `${width}%` } : { width: [`${Math.max(30, width - 20)}%`, `${width}%`, `${Math.min(100, width + 8)}%`] }}
              transition={{ duration: 1.2, repeat: Infinity, delay: index * 0.12 }}
            />
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-5 gap-1.5">
        {Array.from({ length: 10 }).map((_, index) => (
          <MotionSpan
            key={index}
            className="h-4 rounded-sm border border-violet-200/22 bg-violet-300/15"
            animate={reducedMotion ? undefined : { opacity: [0.2, 1, 0.2] }}
            transition={{ duration: 0.7, repeat: Infinity, delay: index * 0.07 }}
          />
        ))}
      </div>
    </div>
  );
}

function SectionIndicator({ activeSection, sectionCount }) {
  const clamped = Math.min(sectionCount, Math.max(1, activeSection));
  const progress = (clamped / sectionCount) * 100;

  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-full border border-white/12 bg-black/55 px-3 py-2 text-[0.62rem] uppercase tracking-[0.18em] text-zinc-300 backdrop-blur-md">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span>Section</span>
        <span>{clamped}/{sectionCount}</span>
      </div>
      <div className="h-px w-24 bg-white/20">
        <MotionDiv className="h-px bg-gradient-to-r from-cyan-300 to-[#0A8780]" animate={{ width: `${progress}%` }} transition={{ duration: 0.4, ease: 'easeOut' }} />
      </div>
    </div>
  );
}

export default function LandingPage() {
  const navigate = useNavigate();
  const sectionIds = useMemo(() => ['hero', 'features', 'pricing'], []);
  const {
    reducedMotion,
    viewport,
    cursorRef,
    smoothedCursorRef,
    smoothCursorX,
    smoothCursorY,
    activeSection,
    sectionCount,
    heroDemo,
  } = useLandingMotion(sectionIds);

  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const heroParallaxX = useTransform(smoothCursorX, (value) => ((value - viewport.width / 2) / (viewport.width || 1)) * 28);
  const heroParallaxY = useTransform(smoothCursorY, (value) => ((value - viewport.height / 2) / (viewport.height || 1)) * 24);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-black text-zinc-50 selection:bg-cyan-300/30">
      <GenerativeGridCanvas cursorRef={cursorRef} smoothedCursorRef={smoothedCursorRef} reducedMotion={reducedMotion} />

      <nav
        className={`fixed inset-x-0 top-0 z-40 border-b transition-all duration-500 ${
          isScrolled
            ? 'border-white/12 bg-black/55 backdrop-blur-[8px]'
            : 'border-white/[0.04] bg-transparent'
        }`}
      >
        <div className="mx-auto flex h-20 w-full max-w-7xl items-center justify-between px-5 sm:px-8 lg:px-10">
          <a href="#hero" className="flex items-center gap-2.5 text-zinc-100">
            <span className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-200/35 bg-black/70">
              <Wand2 className="h-4 w-4 text-cyan-200" strokeWidth={1.6} />
            </span>
            <span className="font-serif text-xl tracking-wide">AdReady</span>
          </a>

          <div className="hidden items-center gap-8 md:flex">
            {NAV_ITEMS.map((item) => (
              <NavLinkWithRay key={item.label} href={item.href} label={item.label} />
            ))}
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="text-xs uppercase tracking-[0.2em] text-zinc-300 transition-colors hover:text-white"
            >
              Sign In
            </button>
          </div>

          <button
            type="button"
            onClick={() => navigate('/login')}
            className="rounded-full border border-cyan-200/42 px-4 py-2 text-xs uppercase tracking-[0.19em] text-cyan-100 transition-all hover:border-cyan-200 hover:bg-cyan-300/10"
          >
            Start Free
          </button>
        </div>
      </nav>

      <main className="relative z-10">
        <section id="hero" className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 pb-24 pt-32 sm:px-8 lg:px-10">
          <div className="mx-auto flex w-full max-w-5xl flex-col items-center text-center">
            <BadgePill />

            <h1 className="max-w-5xl leading-[1.02] text-zinc-100">
              <span className="font-serif text-5xl sm:text-6xl lg:text-7xl">The AI design tool for</span>
              <br />
              <span className="hero-liquid-text block font-sans text-5xl font-semibold tracking-tight sm:text-6xl lg:text-7xl">creative content</span>
            </h1>

            <p className="mt-8 max-w-3xl text-base leading-relaxed text-zinc-300/84 sm:text-lg">
              Build stunning AI product content and manipulate images with your team in real-time. Unprecedented control, built for modern creators.
            </p>

            <div className="mt-10 flex w-full flex-col items-center justify-center gap-4 sm:w-auto sm:flex-row">
              <MotionButton
                type="button"
                onClick={() => navigate('/login')}
                className="group relative inline-flex h-12 items-center justify-center overflow-hidden rounded-full border border-cyan-200/22 bg-[linear-gradient(135deg,#1DDECB,#0A8780)] px-7 text-sm font-semibold tracking-[0.12em] text-[#032521] shadow-[0_18px_45px_rgba(12,130,124,0.45)]"
                whileHover={reducedMotion ? undefined : { scale: 1.02, y: -1.5 }}
                whileTap={reducedMotion ? undefined : { scale: 0.98 }}
              >
                <span className="absolute inset-x-2 top-1.5 h-1/3 rounded-full bg-white/35 blur-sm" />
                <span className="relative">Get Started for Free</span>
              </MotionButton>
              <ScrambleDemoButton reducedMotion={reducedMotion} />
            </div>
          </div>

          <ShowcasePanel
            heroDemo={heroDemo}
            reducedMotion={reducedMotion}
            parallaxStyle={{ x: reducedMotion ? 0 : heroParallaxX, y: reducedMotion ? 0 : heroParallaxY }}
          />
        </section>

        <section id="features" className="mx-auto w-full max-w-7xl px-5 pb-28 pt-16 sm:px-8 lg:px-10">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-serif text-4xl text-zinc-100 sm:text-5xl">Crafted for perfection.</h2>
            <p className="mt-4 text-base text-zinc-300/80 sm:text-lg">Everything you need to create production-ready assets.</p>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            <FeatureCard
              accentClass="shadow-[0_22px_65px_rgba(11,173,161,0.22)]"
              title="Precise Control"
              description="Direct the AI with structural precision. Drop elements exactly where you want them."
              reducedMotion={reducedMotion}
              widget={({ isHovered }) => <PreciseControlWidget isHovered={isHovered} reducedMotion={reducedMotion} />}
            />
            <FeatureCard
              accentClass="shadow-[0_22px_65px_rgba(49,113,225,0.2)]"
              title="Smart Generation"
              description="Advanced background removal and seamless object blending in seconds."
              reducedMotion={reducedMotion}
              widget={({ isHovered }) => <SmartGenerationWidget isHovered={isHovered} reducedMotion={reducedMotion} />}
            />
            <FeatureCard
              accentClass="shadow-[0_22px_65px_rgba(130,92,255,0.22)]"
              title="Lightning Fast"
              description="Generate high-quality variations instantly. Iterate faster than ever before."
              reducedMotion={reducedMotion}
              widget={({ isHovered }) => <LightningFastWidget isHovered={isHovered} reducedMotion={reducedMotion} />}
            />
          </div>
        </section>

        <section id="pricing" className="mx-auto w-full max-w-7xl px-5 pb-28 sm:px-8 lg:px-10">
          <div className="rounded-[1.8rem] border border-white/12 bg-white/[0.02] p-8 backdrop-blur-sm sm:p-10">
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-zinc-400">Pricing</p>
                <h3 className="mt-3 font-serif text-3xl text-zinc-100 sm:text-4xl">Scale creative production with your team.</h3>
              </div>
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="rounded-full border border-cyan-200/40 px-5 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 transition-colors hover:bg-cyan-300/10"
              >
                Start Free
              </button>
            </div>
          </div>
        </section>
      </main>

      <SectionIndicator activeSection={activeSection} sectionCount={sectionCount} />
    </div>
  );
}

