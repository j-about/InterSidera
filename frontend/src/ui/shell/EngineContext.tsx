import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

import type { SkyEngineApi } from '../../sky/engine/types';

// How the shell reaches the engine API (plan D93): `SkyCanvas` reports the created engine through
// `onEngine`, `App` keeps it in state and provides it here, and event handlers (the PNG export)
// read it with `useEngine()`. Nothing renders from it: everything the engine acts on over time
// flows through the store, and React never drives the canvas (brief l.409).

const EngineContext = createContext<SkyEngineApi | null>(null);

export interface EngineProviderProps {
  engine: SkyEngineApi | null;
  children: ReactNode;
}

export function EngineProvider({ engine, children }: EngineProviderProps) {
  return <EngineContext value={engine}>{children}</EngineContext>;
}

/** The running engine, `null` before it exists or after it was torn down. */
export function useEngine(): SkyEngineApi | null {
  return useContext(EngineContext);
}
