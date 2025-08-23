import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import styles from "./index.module.css";
import { useEffect, useRef, useState } from "react";

function LightningBackground() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const lightningCount = 150;
    const lightning = "⚡";

    for (let i = 0; i < lightningCount; i++) {
      const bolt = document.createElement("span");
      bolt.textContent = lightning;
      bolt.className = styles.lightningBolt;
      bolt.style.left = `${Math.random() * 100}%`;
      bolt.style.top = `${Math.random() * 100}%`;
      bolt.style.animationDelay = `${Math.random() * 20}s`;
      bolt.style.animationDuration = `${20 + Math.random() * 15}s`;
      container.appendChild(bolt);
    }

    return () => {
      container.innerHTML = "";
    };
  }, []);

  return <div ref={containerRef} className={styles.lightningBackground} />;
}

function LogoCube({ onHover }: { onHover: (hovering: boolean) => void }) {
  const cubeRef = useRef<HTMLDivElement>(null);
  const [rotation, setRotation] = useState({ x: -10, y: 20 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!cubeRef.current) return;
      
      const rect = cubeRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      const angleY = ((e.clientX - centerX) / window.innerWidth) * 40;
      const angleX = -((e.clientY - centerY) / window.innerHeight) * 40;
      
      setRotation({ x: angleX, y: angleY });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  return (
    <div 
      className={styles.logoContainer}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div className={styles.logoGlow} />
      <div 
        ref={cubeRef}
        className={styles.logoCube}
        style={{
          transform: `rotateX(${rotation.x}deg) rotateY(${rotation.y}deg)`
        }}
      >
        <div className={styles.cubeFace}>
          <img src="/img/electrobun-logo-256.png" alt="Electrobun" />
        </div>
        <div className={styles.cubeFace}>
          <img src="/img/electrobun-logo-256.png" alt="Electrobun" />
        </div>
        <div className={styles.cubeFace}>
          <img src="/img/electrobun-logo-256.png" alt="Electrobun" />
        </div>
        <div className={styles.cubeFace}>
          <img src="/img/electrobun-logo-256.png" alt="Electrobun" />
        </div>
        <div className={styles.cubeFace}>
          <img src="/img/electrobun-logo-256.png" alt="Electrobun" />
        </div>
        <div className={styles.cubeFace}>
          <img src="/img/electrobun-logo-256.png" alt="Electrobun" />
        </div>
      </div>
    </div>
  );
}

export default function Home(): JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const animationTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const triggerElectric = (hovering: boolean) => {
    if (!hovering) return;
    
    // Clear any existing timeout
    if (animationTimeoutRef.current) {
      clearTimeout(animationTimeoutRef.current);
    }
    
    // Remove class first to reset animation
    if (titleRef.current) {
      titleRef.current.classList.remove(styles.electric);
      
      // Force reflow to restart animation
      void titleRef.current.offsetWidth;
      
      // Add class back
      titleRef.current.classList.add(styles.electric);
      
      // Always remove after animation completes
      animationTimeoutRef.current = setTimeout(() => {
        if (titleRef.current) {
          titleRef.current.classList.remove(styles.electric);
        }
        animationTimeoutRef.current = null;
      }, 500);
    }
  };

  useEffect(() => {
    return () => {
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
    };
  }, []);
  
  return (
    <Layout title={`${siteConfig.title}`} description="Build ultra fast, tiny, cross-platform desktop apps with TypeScript">
      <main className={styles.heroSection}>
        <LightningBackground />
        
        <div className={styles.heroContent}>
          <h1 ref={titleRef} className={styles.heroTitle}>Electrobun</h1>
          
          <p className={styles.heroSubtitle}>
            Build ultra fast, tiny, and cross-platform desktop applications with TypeScript.
            <br />
            Ship apps that start in milliseconds, update in kilobytes.
          </p>

          <LogoCube onHover={triggerElectric} />

          <div className={styles.installSection}>
            <h2 className={styles.sectionTitle}>Start Building in Seconds</h2>
            <div className={styles.codeBlock}>
              <span className={styles.codePrefix}>$</span>
              <span className={styles.codeText}>bunx electrobun init</span>
            </div>
          </div>

          <div className={styles.featuresGrid}>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon}>⚡</div>
              <h3 className={styles.featureTitle}>Lightning Fast</h3>
              <p className={styles.featureDescription}>
                Powered by Bun runtime and native Zig bindings. Apps start instantly with minimal memory footprint.
              </p>
            </div>

            <div className={styles.featureCard}>
              <div className={styles.featureIcon}>📦</div>
              <h3 className={styles.featureTitle}>Incredibly Small</h3>
              <p className={styles.featureDescription}>
                Self-extracting bundles ~14MB. Ship updates as small as 4KB. Save bandwidth, update frequently.
              </p>
            </div>

            <div className={styles.featureCard}>
              <div className={styles.featureIcon}>🔷</div>
              <h3 className={styles.featureTitle}>Pure TypeScript</h3>
              <p className={styles.featureDescription}>
                Write TypeScript for both main process and webviews. One language, zero configuration hassle.
              </p>
            </div>

            <div className={styles.featureCard}>
              <div className={styles.featureIcon}>🔐</div>
              <h3 className={styles.featureTitle}>Secure by Design</h3>
              <p className={styles.featureDescription}>
                Process isolation with fast, typed RPC. Built-in security best practices from day one.
              </p>
            </div>

            <div className={styles.featureCard}>
              <div className={styles.featureIcon}>🚀</div>
              <h3 className={styles.featureTitle}>Ship in Minutes</h3>
              <p className={styles.featureDescription}>
                Complete build toolchain included. Code signing, auto-updates, and distribution built-in.
              </p>
            </div>

            <div className={styles.featureCard}>
              <div className={styles.featureIcon}>🎯</div>
              <h3 className={styles.featureTitle}>Cross-Platform</h3>
              <p className={styles.featureDescription}>
                Build once, run everywhere. Native performance on Windows, macOS, and Linux.
              </p>
            </div>
          </div>

          <div className={styles.ctaSection}>
            <h2 className={styles.sectionTitle}>Ready to Build Something Amazing?</h2>
            <div className={styles.ctaButtons}>
              <a href="/docs/guides/getting-started" className={styles.primaryButton}>
                Get Started
              </a>
              <a href="/docs" className={styles.secondaryButton}>
                Read the Docs
              </a>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
}