export type Resource = 'wood' | 'brick' | 'wheat' | 'sheep' | 'ore' | 'desert';
export type ProducingResource = Exclude<Resource, 'desert'>;
export type PortType = ProducingResource | 'generic';
export type PlayerCount = 3 | 4 | 5 | 6;

export type ChallengeFlavor = 'none' | 'scarcity' | 'boomOrBust' | 'drought' | 'random';
export type ChallengeRolled = Exclude<ChallengeFlavor, 'none' | 'random'>;

export interface AxialCoord {
  q: number;
  r: number;
}

export interface Hex extends AxialCoord {
  id: string;
  resource: Resource;
  number: number | null;
}

export interface Port {
  hexId: string;
  side: 0 | 1 | 2 | 3 | 4 | 5;
  type: PortType;
}

export interface Variants {
  includeDesert: boolean;
  desertReplacement: ProducingResource;
  shufflePorts: boolean;
  noSameNumberAdjacent: boolean;
  noSameNumberOnResource: boolean;
  noMultipleRedsOnResource: boolean;
  challenge: {
    flavor: ChallengeFlavor;
    targetResource: ProducingResource | 'any';
    rolledFlavor?: ChallengeRolled;
    rolledTarget?: ProducingResource;
  };
}

export interface MapState {
  playerCount: PlayerCount;
  hexes: Hex[];
  ports: Port[];
  variants: Variants;
  /** u32 seed fed directly to mulberry32. Display as base36 for humans. */
  seed: number;
}

export interface Intersection {
  id: string;
  hexIds: string[];
  neighbors: string[];
  x: number;
  y: number;
}

export interface SpotScore {
  intersectionId: string;
  pipValue: number;
  diversityBonus: number;
  portBonus: number;
  synergyBonus: number;
  scarcityBonus: number;
  expansionBonus: number;
  sameNumberPenalty: number;
  total: number;
  hasRoadCombo: boolean;
  hasCityCombo: boolean;
  hasSettlementCombo: boolean;
}

export interface ResourceHealth {
  resource: ProducingResource;
  totalPips: number;
  pipVariance: number;
  concentration: number;
  topNumber: number | null;
  status: 'healthy' | 'warning' | 'unhealthy';
}

export interface FairnessReport {
  playerTotals: number[];
  stdev: number;
  spread: number;
  picks: Array<{ playerIndex: number; intersectionId: string; value: number }>;
}
