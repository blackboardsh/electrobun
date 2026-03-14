import { createSignal, createEffect, onCleanup } from "solid-js";

const mathFormulas = [
  "∫ e^(-x²/2) dx = √(2π)",
  "∇²ψ + k²ψ = 0",
  "E = mc²",
  "∂u/∂t = α∇²u",
  "F = ma = dp/dt",
  "∮ E · dl = -dΦ/dt",
  "H(x) = -Σ p log(p)",
  "∂/∂x(g ∂φ/∂x) = 0",
  "δS = ∫ δL dt = 0",
  "⟨ψ|H|ψ⟩ = E⟨ψ|ψ⟩",
  "∇ × B = μJ + με∂E/∂t",
  "det(A - λI) = 0",
  "Π(1 + x) = Σ e(x)",
  "lim (f(x+h) - f(x))/h = f'(x)",
  "∫∫∫ (∇ · F) dV = ∮∮ F · n dS",
  "a² + b² = c²",
  "sin²θ + cos²θ = 1",
  "e^(iπ) + 1 = 0",
  "∑ 1/n² = π²/6",
  "∂²f/∂x² + ∂²f/∂y² = 0"
];

export const BlackboardAnimation = () => {
  const [formulas, setFormulas] = createSignal<{text: string, x: number, y: number, opacity: number, progress: number, id: number}[]>([]);
  let animationId: number;
  let nextId = 0;

  createEffect(() => {
    let frameCount = 0;
    
    const animate = () => {
      frameCount++;
      
      // Add new formula every ~2 seconds at 60fps
      if (frameCount % 120 === 0 && formulas().length < 5) {
        const newFormula = {
          text: mathFormulas[Math.floor(Math.random() * mathFormulas.length)],
          x: Math.random() * 70 + 15, // 15-85% from left
          y: Math.random() * 70 + 15, // 15-85% from top
          opacity: 0.25,
          progress: 0, // Start with no characters visible
          id: nextId++
        };
        
        setFormulas(prev => [...prev, newFormula]);
      }

      // Update existing formulas every frame for smooth animation
      setFormulas(prev => 
        prev.map(formula => {
          if (formula.progress < 1) {
            // Writing phase - reveal characters from left to right
            return {
              ...formula,
              progress: Math.min(formula.progress + 0.015, 1) // Reveal over ~67 frames (1+ seconds)
            };
          } else {
            // Fade out phase after writing is complete
            return {
              ...formula,
              opacity: Math.max(formula.opacity - 0.001, 0) // Slowly fade out
            };
          }
        })
        .filter(formula => formula.opacity > 0.001) // Remove fully faded formulas
      );

      animationId = requestAnimationFrame(animate);
    };

    animate();
  });

  onCleanup(() => {
    if (animationId) {
      cancelAnimationFrame(animationId);
    }
  });

  return (
    <div style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      "pointer-events": "none",
      "font-family": "Times, serif",
      "font-style": "italic",
      color: "#ffffff",
      "z-index": 0,
      overflow: "hidden"
    }}>
      {formulas().map(formula => {
        const visibleLength = Math.floor(formula.text.length * formula.progress);
        const visibleText = formula.text.substring(0, visibleLength);
        
        return (
          <div
            style={{
              position: "absolute",
              left: `${formula.x}%`,
              top: `${formula.y}%`,
              opacity: formula.opacity,
              "font-size": "18px",
              "white-space": "nowrap",
              "text-shadow": "0 0 2px rgba(255,255,255,0.3)",
              "user-select": "none",
              color: "#f5f5f5",
              "font-family": "Times, serif",
              "font-style": "italic"
            }}
          >
            <span style={{ visibility: "visible" }}>{visibleText}</span>
            <span style={{ visibility: "hidden" }}>{formula.text.substring(visibleLength)}</span>
          </div>
        );
      })}
    </div>
  );
};