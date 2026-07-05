import { useState } from 'react';
import type { GameSettings } from '../game';
import { loadSettings, saveSettings } from '../settings';
import { Menu } from './Menu';
import { GameView } from './GameView';

export function App() {
  const [settings, setSettings] = useState<GameSettings>(loadSettings);
  const [inGame, setInGame] = useState(false);

  const update = (s: GameSettings) => {
    setSettings(s);
    saveSettings(s);
  };

  return inGame ? (
    <GameView settings={settings} onExit={() => setInGame(false)} />
  ) : (
    <Menu
      settings={settings}
      onChange={update}
      onStart={() => setInGame(true)}
    />
  );
}
