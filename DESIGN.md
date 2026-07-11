---
name: DSim
colors:
  surface: '#f9faf7'
  surface-dim: '#d9dad8'
  surface-bright: '#f9faf7'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f4f1'
  surface-container: '#edeeec'
  surface-container-high: '#e7e8e6'
  surface-container-highest: '#e1e3e0'
  on-surface: '#191c1b'
  on-surface-variant: '#404945'
  inverse-surface: '#2e312f'
  inverse-on-surface: '#f0f1ee'
  outline: '#707975'
  outline-variant: '#c0c9c4'
  surface-tint: '#366758'
  primary: '#366758'
  on-primary: '#ffffff'
  primary-container: '#b5ead7'
  on-primary-container: '#396b5c'
  inverse-primary: '#9dd1bf'
  secondary: '#745945'
  on-secondary: '#ffffff'
  secondary-container: '#fdd9c0'
  on-secondary-container: '#785d49'
  tertiary: '#566246'
  on-tertiary: '#ffffff'
  tertiary-container: '#d6e4c0'
  on-tertiary-container: '#5a6649'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#b9eedb'
  primary-fixed-dim: '#9dd1bf'
  on-primary-fixed: '#002018'
  on-primary-fixed-variant: '#1c4f41'
  secondary-fixed: '#ffdcc4'
  secondary-fixed-dim: '#e3c0a8'
  on-secondary-fixed: '#2a1708'
  on-secondary-fixed-variant: '#5a422f'
  tertiary-fixed: '#dae8c3'
  tertiary-fixed-dim: '#becba8'
  on-tertiary-fixed: '#141f08'
  on-tertiary-fixed-variant: '#3f4b30'
  background: '#f9faf7'
  on-background: '#191c1b'
  surface-variant: '#e1e3e0'
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 48px
    fontWeight: '800'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '500'
    lineHeight: 24px
  label-sm:
    fontFamily: Space Grotesk
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 8px
  xs: 4px
  sm: 12px
  md: 24px
  lg: 48px
  gutter: 20px
  margin-mobile: 16px
  margin-desktop: 64px
---

## Brand & Style

The design system is built on an "Indie-Game" aesthetic—capturing the clean, low-poly charm of minimalist driving and simulation games. The brand personality is playful, optimistic, and unburdened by corporate density. It evokes a sense of tactile toy-like interaction where every UI element feels like a physical piece of a digital world.

The design style is a hybrid of **Minimalism** and **Low-Poly Tactility**. It utilizes flat planes of pastel colors and subtle 3D-depth cues (like "thick" buttons) to create a sense of physical space. The interface avoids complex textures, relying instead on geometry, soft shadows, and a warm, inviting atmosphere to guide the user.

## Colors

This design system uses a curated palette of desaturated pastels set against a warm, off-white background to ensure a "cozy" game feel. 

- **Primary (Soft Mint):** Used for main action pathways and primary brand elements.
- **Secondary (Blush/Peach):** Used for supporting elements and secondary highlights.
- **Accents:** Lavender and Sky Blue are reserved for categorization, iconography backgrounds, and subtle decorative low-poly terrain elements.
- **State Colors:** High-contrast Red and Blue are utilized specifically for competitive states, "Win/Loss" scenarios, or "Stop/Go" mechanics, breaking the pastel harmony to command immediate attention.
- **Neutrals:** Text and outlines use a deep charcoal-grey rather than pure black to maintain the soft, cartoonish aesthetic.

## Typography

Typography in the design system strikes a balance between "toy-like" playfulness and functional clarity. 

- **Plus Jakarta Sans** is the workhorse font, chosen for its friendly, rounded terminals and modern geometric construction. It provides the "cartoon" feel without sacrificing legibility. 
- **Space Grotesk** is used sparingly for labels and technical data (like game scores or timers) to introduce a subtle "low-poly/tech" edge.

Large headings should use heavy weights (700-800) to feel "chunky" and significant. Body text maintains a medium weight (500) to ensure readability against the low-contrast pastel backgrounds.

## Layout & Spacing

The layout philosophy follows a **Fluid Grid** model with generous, airy margins that mimic the "open world" feel of a driving game. 

- **The 8px Rhythm:** All spacing—from padding inside cards to the distance between sections—is a multiple of 8px.
- **Desktop:** A 12-column grid with a wide 64px outer margin. Content containers are often centered with significant whitespace to emphasize the minimalist energy.
- **Mobile:** A 4-column grid with 16px margins.
- **Low-Poly Framing:** Rather than standard dividers, use shifts in background color or slight "blocky" offsets to separate sections.

## Elevation & Depth

Depth is achieved through **Tonal Layers** and **Hard-Shadow "Block" effects**. This design system avoids realistic, blurry shadows in favor of a "half-tone" or "offset-flat" shadow style.

1.  **Level 0 (Floor):** The warm off-white background.
2.  **Level 1 (The Road):** Cards and containers with a subtle 1px border in a slightly darker pastel shade.
3.  **Level 2 (Interactive):** Elements like buttons feature a "thick" bottom border (2px to 4px) in a darker shade of the element’s color, creating a 3D "keycap" look.
4.  **Shadows:** When used, shadows are low-blur, high-opacity, and slightly offset to the bottom-right, suggesting a fixed "sun" light source from the top-left, typical of isometric game engines.

## Shapes

The shape language is defined as "Soft-Blocky." While the overall aesthetic is inspired by low-poly geometry, the edges are never sharp/jagged—which would feel too aggressive. 

Instead, the design system uses a consistent 8px (0.5rem) corner radius for most components. This creates a "molded plastic" feel. For high-action elements like primary buttons or "Level Up" notifications, use **Pill-shaped** corners to differentiate them from the standard layout blocks.

## Components

- **Buttons:** Designed to look "pressable." They use a solid background color with a 3px bottom-offset shadow of a darker hue. On "hover," the button moves down 1px; on "click," it moves down 3px to meet its shadow, simulating a physical press.
- **Cards:** Flat pastel backgrounds with a 1px solid stroke. No heavy shadows; instead, use a 4px offset "block shadow" in a complementary pastel shade.
- **Input Fields:** Recessed appearance. Use a slightly darker background than the surface it sits on, with an inner-top shadow to suggest it is carved into the UI.
- **Chips:** Highly rounded (pill-shaped) with "Plus Jakarta Sans" Bold for the text. Use the Lavender and Sky Blue accents here for categorization.
- **Progress Bars:** Thick, chunky bars with rounded caps. The "track" is a light grey-beige, and the "fill" is a vibrant Mint or Sky Blue.
- **Toggles:** Large, circular "puck" inside a rounded-rectangle track. Use high-contrast Blue for the "On" state.
- **Game-Specific Icons:** Use monolinear icons with slightly rounded ends, always centered within a low-poly hexagonal or circular pastel container.