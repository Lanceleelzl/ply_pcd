import * as pc from 'playcanvas';

export class DesktopApplication extends pc.Application {
  override init(options: pc.AppOptions): void {
    // AppBase accepts an absent XR manager; desktop viewports do not use WebXR.
    Reflect.deleteProperty(options, 'xr');
    super.init(options);
  }
}
