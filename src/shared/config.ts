interface IConfig<TConfig extends object> {
  readonly envs: TConfig;
}

class Config<TConfig extends object> implements IConfig<TConfig> {
  public readonly envs: Readonly<TConfig>;

  public constructor(load: () => TConfig) {
    this.envs = Object.freeze(load());
  }
}

export { Config };
export type { IConfig };
