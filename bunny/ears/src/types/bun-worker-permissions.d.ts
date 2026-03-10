declare namespace Bun {
  interface WorkerPermissions {
    read?: boolean;
    write?: boolean;
    env?: boolean;
    run?: boolean;
    ffi?: boolean;
    addons?: boolean;
    worker?: boolean;
    fs?: boolean;
    childProcess?: boolean;
  }

  interface WorkerOptions {
    permissions?: WorkerPermissions;
  }
}
