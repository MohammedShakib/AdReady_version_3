import { useCallback, useEffect, useRef, useState } from 'react';
import { useMotionValue, useReducedMotion, useSpring } from 'framer-motion';

const HERO_OBJECT_ID = 'car-subject';

export function useLandingMotion(sectionIds = []) {
  const reducedMotion = Boolean(useReducedMotion());
  const [viewport, setViewport] = useState({
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 720 : window.innerHeight,
  });

  const cursorRef = useRef({ x: 0, y: 0 });
  const smoothedCursorRef = useRef({ x: 0, y: 0 });

  const cursorX = useMotionValue(0);
  const cursorY = useMotionValue(0);
  const smoothCursorX = useSpring(cursorX, { stiffness: 110, damping: 22, mass: 0.45 });
  const smoothCursorY = useSpring(cursorY, { stiffness: 110, damping: 22, mass: 0.45 });

  const [activeSection, setActiveSection] = useState(1);
  const [heroDemo, setHeroDemo] = useState({
    activeObject: HERO_OBJECT_ID,
    action: 'isolating-background',
    cursor: { x: 280, y: 165 },
    penPath: [],
    progress: 0,
    processing: true,
  });

  const sectionCount = Math.max(1, sectionIds.length);

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      setViewport({ width, height });
      const centered = { x: width / 2, y: height / 2 };
      if (cursorRef.current.x <= 0 || cursorRef.current.y <= 0) {
        cursorRef.current = centered;
        smoothedCursorRef.current = centered;
      }
      cursorX.set(cursorRef.current.x || centered.x);
      cursorY.set(cursorRef.current.y || centered.y);
      smoothCursorX.set(smoothedCursorRef.current.x || centered.x);
      smoothCursorY.set(smoothedCursorRef.current.y || centered.y);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [cursorX, cursorY, smoothCursorX, smoothCursorY]);

  useEffect(() => {
    const handlePointer = (event) => {
      const next = { x: event.clientX, y: event.clientY };
      cursorRef.current = next;
      cursorX.set(next.x);
      cursorY.set(next.y);
    };

    window.addEventListener('pointermove', handlePointer, { passive: true });
    return () => window.removeEventListener('pointermove', handlePointer);
  }, [cursorX, cursorY]);

  useEffect(() => {
    let frameId = null;

    const tick = () => {
      const nextX = smoothedCursorRef.current.x + (cursorRef.current.x - smoothedCursorRef.current.x) * 0.08;
      const nextY = smoothedCursorRef.current.y + (cursorRef.current.y - smoothedCursorRef.current.y) * 0.08;
      smoothedCursorRef.current = { x: nextX, y: nextY };
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  useEffect(() => {
    const updateSection = () => {
      const docs = sectionIds
        .map((id) => ({ id, node: document.getElementById(id) }))
        .filter((entry) => Boolean(entry.node));

      if (docs.length === 0) {
        return;
      }

      const pivot = window.scrollY + window.innerHeight * 0.4;
      let nextIndex = 0;

      docs.forEach((entry, index) => {
        if (entry.node.offsetTop <= pivot) {
          nextIndex = index;
        }
      });

      setActiveSection(nextIndex + 1);
    };

    let raf = null;
    const handleScroll = () => {
      if (raf !== null) {
        return;
      }
      raf = window.requestAnimationFrame(() => {
        updateSection();
        raf = null;
      });
    };

    updateSection();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (raf !== null) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [sectionIds]);

  useEffect(() => {
    if (reducedMotion) {
      return undefined;
    }

    let intervalId = null;
    const started = performance.now();

    const step = () => {
      const elapsed = (performance.now() - started) / 1000;
      const cycle = 8.2;
      const phase = (elapsed % cycle) / cycle;
      const processing = phase < 0.9;
      const progress = processing ? phase / 0.9 : 1;
      const cursor = {
        x: Math.round(116 + progress * 420 + Math.sin(elapsed * 2.1) * 26),
        y: Math.round(128 + Math.cos(elapsed * 2.4) * 56),
      };
      const action = processing ? 'isolating-background' : 'blending-studio-light';

      setHeroDemo((previous) => {
        const penPath = [...previous.penPath, { ...cursor, t: elapsed }].slice(-18);
        return {
          activeObject: HERO_OBJECT_ID,
          action,
          cursor,
          penPath,
          progress,
          processing,
        };
      });
    };

    intervalId = window.setInterval(step, 48);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [reducedMotion]);

  const reducedMotionHeroDemo = {
    activeObject: HERO_OBJECT_ID,
    action: 'preview-ready',
    cursor: { x: 300, y: 170 },
    penPath: [],
    progress: 1,
    processing: false,
  };

  const setHeroAction = useCallback((action) => {
    setHeroDemo((previous) => ({ ...previous, action }));
  }, []);

  return {
    reducedMotion,
    viewport,
    cursorRef,
    smoothedCursorRef,
    cursorX,
    cursorY,
    smoothCursorX,
    smoothCursorY,
    activeSection,
    sectionCount,
    setActiveSection,
    heroDemo: reducedMotion ? reducedMotionHeroDemo : heroDemo,
    setHeroDemo,
    setHeroAction,
  };
}
