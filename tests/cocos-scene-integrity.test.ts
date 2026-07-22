import { describe, expect, it } from 'vitest';
import sceneSource from '../assets/scenes/Game.scene?raw';
import engineSettings from '../settings/v2/packages/engine.json';
import gameRunnerSource from '../assets/scripts/cocos/GameRunner.ts?raw';

describe('Cocos 纯 2D 场景完整性', () => {
  it('主场景不再序列化 3D 灯光或启用天空盒', () => {
    expect(sceneSource).not.toContain('cc.DirectionalLight');
    expect(sceneSource).not.toContain('d032ac98-05e1-4090-88bb-eb640dcb5fc1');
    expect(sceneSource).not.toContain('6f01cf7f-81bf-4a7e-bd5d-0afc19696480');

    const scene = JSON.parse(sceneSource) as Array<Record<string, unknown>>;
    const skybox = scene.find((entry) => entry.__type__ === 'cc.SkyboxInfo');
    expect(skybox?._enabled).toBe(false);
  });

  it('关闭未使用的 3D，同时保留 Creator 默认材质所需的物理兼容后端', () => {
    const settings = engineSettings as {
      modules: {
        configs: {
          defaultConfig: {
            cache: Record<string, { _value: boolean; _option?: string }>;
            includeModules: string[];
          };
        };
      };
    };
    const config = settings.modules.configs.defaultConfig;
    expect(config.cache['3d']._value).toBe(false);
    expect(config.cache.physics._value).toBe(true);
    expect(config.cache.physics._option).toBe('physics-builtin');
    expect(config.cache['physics-builtin']._value).toBe(true);
    expect(config.includeModules).not.toContain('3d');
    expect(config.includeModules).toContain('physics-builtin');
  });

  it('道具按钮在节点内闭环接收松手，微信端不依赖全局 TOUCH_END 才能投出', () => {
    expect(gameRunnerSource).toContain('btn.on(Node.EventType.TOUCH_START');
    expect(gameRunnerSource).toContain('btn.on(Node.EventType.TOUCH_END');
    expect(gameRunnerSource).toContain('btn.on(Node.EventType.TOUCH_CANCEL');
    expect(gameRunnerSource).not.toContain('btn.on(Node.EventType.TOUCH_MOVE');
  });
});
