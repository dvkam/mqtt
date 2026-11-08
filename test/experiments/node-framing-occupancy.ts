export interface FramingOccupancy {
  readonly peakNativeBytes: number;
  readonly peakNativeFragments: number;
  readonly peakAssemblyCapacity: number;
  readonly currentNativeBytes: number;
  readonly currentNativeFragments: number;
  readonly currentAssemblyCapacity: number;
}

export function observeFramingOccupancy(_decoder: unknown, _strategy: 'compact' | 'streaming') {
  return {
    snapshot(): FramingOccupancy {
      return { peakNativeBytes: 0, peakNativeFragments: 0, peakAssemblyCapacity: 0, currentNativeBytes: 0, currentNativeFragments: 0, currentAssemblyCapacity: 0 };
    },
    restore(): void {},
  };
}
