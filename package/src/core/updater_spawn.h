#ifndef ELECTROBUN_UPDATER_SPAWN_H
#define ELECTROBUN_UPDATER_SPAWN_H

/* Start the validated helper detached from the application, with all application handles
 * closed. Return zero on success and write its process ID to child_pid. */
int electrobun_updater_spawn(const char *helper, const char *plan, int *child_pid);

#endif
