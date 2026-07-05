import { useState } from 'react';
import type { GameSettings } from '../game';
import { DEFAULT_SPEC } from '../sim/spawn';
import { Menu } from './Menu';
import { GameView } from './GameView';

export function App() {
  const [settings, setSettings] = useState<GameSettings>({
    mode: 'match',
    alliance: 'blue',
    assists: { fieldCentric: true, aimAssist: true, autoIntake: false, autoFire: false },
    spec: { ...DEFAULT_SPEC },
  });
  const [inGame, setInGame] = useState(false);

  return inGame ? (
    <GameView settings={settings} onExit={() => setInGame(false)} />
  ) : (
    <Menu
      settings={settings}
      onChange={setSettings}
      onStart={() => setInGame(true)}
    />
  );
}
