#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif
#include "updater_spawn.h"

#ifdef _WIN32
/* Windows hands off through Task Scheduler instead of POSIX spawn. */
int electrobun_updater_spawn(const char *helper, const char *plan, int *child_pid) {
    (void)helper;
    (void)plan;
    (void)child_pid;
    return -1;
}
#else
#include <spawn.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

extern char **environ;

int electrobun_updater_spawn(const char *helper, const char *plan, int *child_pid) {
    posix_spawnattr_t attributes;
    posix_spawn_file_actions_t actions;
    int result = posix_spawnattr_init(&attributes);
    if (result != 0) return result;
    short flags = POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF;
#ifdef POSIX_SPAWN_CLOEXEC_DEFAULT
    flags |= POSIX_SPAWN_CLOEXEC_DEFAULT;
#endif
    result = posix_spawnattr_setflags(&attributes, flags);
    if (result != 0) goto destroy_attributes;
    sigset_t mask;
    result = sigemptyset(&mask);
    if (result != 0) goto destroy_attributes;
    result = posix_spawnattr_setsigmask(&attributes, &mask);
    if (result != 0) goto destroy_attributes;
    sigset_t defaults;
    result = sigfillset(&defaults);
    if (result != 0) goto destroy_attributes;
    result = posix_spawnattr_setsigdefault(&attributes, &defaults);
    if (result != 0) goto destroy_attributes;
    result = posix_spawn_file_actions_init(&actions);
    if (result != 0) goto destroy_attributes;
    for (int fd = 0; fd < 3; ++fd) {
        result = posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0);
        if (result != 0) goto destroy_actions;
    }
#ifdef __linux__
    /* Never keep UI/platform-app sockets or profile handles alive while the
     * detached helper waits for the old application to terminate. */
    result = posix_spawn_file_actions_addclosefrom_np(&actions, 3);
    if (result != 0) goto destroy_actions;
#endif
    char *argv[] = { (char *)helper, "--apply-update", (char *)plan, "--quiet", 0 };
    pid_t pid = 0;
    result = posix_spawn(&pid, helper, &actions, &attributes, argv, environ);
    if (result == 0) *child_pid = (int)pid;
destroy_actions:
    posix_spawn_file_actions_destroy(&actions);
destroy_attributes:
    posix_spawnattr_destroy(&attributes);
    return result;
}
#endif
