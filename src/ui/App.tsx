import { useState } from 'react';
import type { GameSettings } from '../game';
import { loadSettings, saveSettings } from '../settings';
import { Menu } from './Menu';
import { GameView } from './GameView';
import { Lobby } from './Lobby';
import { gameServerConfigured } from '../net/env';
import type { NetSession } from '../net/session';

type Screen = 'menu' | 'lobby' | 'game';

export function App() {
  const [settings, setSettings] = useState<GameSettings>(loadSettings);
  const [screen, setScreen] = useState<Screen>('menu');
  const [session, setSession] = useState<NetSession | null>(null);

  const update = (s: GameSettings) => {
    setSettings(s);
    saveSettings(s);
  };

  const exitGame = () => {
    session?.dispose();
    setSession(null);
    setScreen('menu');
  };

  if (screen === 'game') {
    return <GameView settings={settings} session={session} onExit={exitGame} />;
  }
  if (screen === 'lobby') {
    return (
      <Lobby
        settings={settings}
        onStart={(s) => {
          setSession(s);
          setScreen('game');
        }}
        onCancel={() => setScreen('menu')}
      />
    );
  }
  return (
    <Menu
      settings={settings}
      onChange={update}
      onStart={() => setScreen('game')}
      onMultiplayer={gameServerConfigured() ? () => setScreen('lobby') : undefined}
    />
  );
}
