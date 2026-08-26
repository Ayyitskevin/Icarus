// icarus-landlock-sandbox — apply a Landlock filesystem ruleset to the current
// process, then exec the wrapped command. ADR 0062.
//
// This helper is the kernel backstop beneath the Icarus grant pipeline. It is
// compiled on demand by the CLI with the host C compiler and executed only
// BEFORE the sandboxed process starts: it restricts its own thread (Landlock
// is one-way and inherited across execve) and then replaces itself with the
// wrapped command. It never links against or loads anything from the
// repository being worked on.
//
// Usage:
//   landlock-sandbox --probe
//       Print the kernel Landlock ABI version (0 when unsupported) and exit.
//   landlock-sandbox [--ro PATH]... [--rw PATH]... [--meta PATH]... -- CMD [ARG]...
//       Build the ruleset, restrict self, then exec CMD.
//
// Access classes (requested rights are masked down to what the detected ABI
// supports):
//   ro   = READ_FILE | READ_DIR | EXECUTE
//   rw   = every filesystem right the ABI handles
//   meta = ro | MAKE_DIR | MAKE_REG | REMOVE_FILE | MAKE_REFER
//          (directory entry lifecycle without file-content writes; used for
//          the state root so SQLite WAL sidecars can appear and disappear
//          while file contents stay confined to explicit rw paths)
//
// Exit codes: 0 on probe success; 70 (EX_OSERR) on kernel/setup errors;
// 64 (EX_USAGE) on argument errors; 71 on exec failure. Any error message is
// written to stderr before the exit.
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__has_include)
#if __has_include(<linux/landlock.h>)
#include <linux/landlock.h>
#define ICARUS_HAVE_LANDLOCK_HEADER 1
#endif
#endif

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif
#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

#if !defined(ICARUS_HAVE_LANDLOCK_HEADER)
// Fallback definitions for build hosts whose kernel headers predate Landlock.
// The values are ABI-stable and defined by the kernel UAPI.
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)

#define LANDLOCK_ACCESS_FS_EXECUTE (1ULL << 0)
#define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 1)
#define LANDLOCK_ACCESS_FS_READ_FILE (1ULL << 2)
#define LANDLOCK_ACCESS_FS_READ_DIR (1ULL << 3)
#define LANDLOCK_ACCESS_FS_REMOVE_DIR (1ULL << 4)
#define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#define LANDLOCK_ACCESS_FS_MAKE_CHAR (1ULL << 6)
#define LANDLOCK_ACCESS_FS_MAKE_DIR (1ULL << 7)
#define LANDLOCK_ACCESS_FS_MAKE_REG (1ULL << 8)
#define LANDLOCK_ACCESS_FS_MAKE_SOCK (1ULL << 9)
#define LANDLOCK_ACCESS_FS_MAKE_FIFO (1ULL << 10)
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#define LANDLOCK_ACCESS_FS_MAKE_SYM (1ULL << 12)
#define LANDLOCK_ACCESS_FS_MAKE_REFER (1ULL << 13)
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)

#define LANDLOCK_RULE_PATH_BENEATH 1

struct landlock_ruleset_attr {
  __u64 handled_access_fs;
};

struct landlock_path_beneath_attr {
  __u64 allowed_access;
  __s32 parent_fd;
};
#endif

#ifndef LANDLOCK_ACCESS_FS_MAKE_REFER
#define LANDLOCK_ACCESS_FS_MAKE_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

typedef unsigned long long ll_access_t;

static int ll_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size, __u32 flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int ll_add_rule(int ruleset_fd, int rule_type, const void *rule_attr, __u32 flags) {
  return (int)syscall(__NR_landlock_add_rule, ruleset_fd, rule_type, rule_attr, flags);
}

static int ll_restrict_self(int ruleset_fd, __u32 flags) {
  return (int)syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

static ll_access_t abi_base_rights(void) {
  return LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
         LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
         LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
         LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
         LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
         LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
         LANDLOCK_ACCESS_FS_MAKE_SYM;
}

static ll_access_t handled_rights_for_abi(int abi) {
  ll_access_t rights = abi_base_rights();
  if (abi >= 2) {
    rights |= LANDLOCK_ACCESS_FS_MAKE_REFER;
  }
  if (abi >= 3) {
    rights |= LANDLOCK_ACCESS_FS_TRUNCATE;
  }
  return rights;
}

static int detect_abi(void) {
  const int abi = ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    return 0;
  }
  return abi;
}

static ll_access_t access_for_class(const char *name, ll_access_t handled) {
  const ll_access_t read_only =
      LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_EXECUTE;
  if (strcmp(name, "ro") == 0) {
    return read_only & handled;
  }
  if (strcmp(name, "rw") == 0) {
    return handled;
  }
  if (strcmp(name, "meta") == 0) {
    return (read_only | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
            LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_REFER) &
           handled;
  }
  fprintf(stderr, "landlock-sandbox: unknown access class %s\n", name);
  exit(64);
}

static void add_path_rule(int ruleset_fd, ll_access_t handled, const char *access_class,
                          const char *path) {
  const int path_fd = open(path, O_PATH | O_CLOEXEC);
  if (path_fd < 0) {
    fprintf(stderr, "landlock-sandbox: cannot open rule path %s: %s\n", path, strerror(errno));
    exit(70);
  }
  struct stat path_stat;
  if (fstat(path_fd, &path_stat) != 0) {
    fprintf(stderr, "landlock-sandbox: cannot stat rule path %s: %s\n", path, strerror(errno));
    close(path_fd);
    exit(70);
  }
  ll_access_t allowed = access_for_class(access_class, handled);
  if (!S_ISDIR(path_stat.st_mode)) {
    // The kernel rejects rules carrying directory-only rights on a
    // non-directory path; only file-applicable rights may remain.
    allowed &= LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
               LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
  }
  struct landlock_path_beneath_attr rule;
  memset(&rule, 0, sizeof(rule));
  rule.allowed_access = allowed;
  rule.parent_fd = path_fd;
  if (ll_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0) {
    fprintf(stderr, "landlock-sandbox: cannot add rule for %s: %s\n", path, strerror(errno));
    close(path_fd);
    exit(70);
  }
  close(path_fd);
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--probe") == 0) {
    printf("%d\n", detect_abi());
    return 0;
  }

  const int abi = detect_abi();
  if (abi < 1) {
    fprintf(stderr, "landlock-sandbox: kernel does not support Landlock\n");
    return 70;
  }
  const ll_access_t handled = handled_rights_for_abi(abi);
  struct landlock_ruleset_attr ruleset;
  memset(&ruleset, 0, sizeof(ruleset));
  ruleset.handled_access_fs = handled;
  const int ruleset_fd = ll_create_ruleset(&ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) {
    fprintf(stderr, "landlock-sandbox: cannot create ruleset: %s\n", strerror(errno));
    return 70;
  }

  int index = 1;
  for (; index < argc; index += 1) {
    const char *token = argv[index];
    if (strcmp(token, "--") == 0) {
      index += 1;
      break;
    }
    if (strncmp(token, "--", 2) != 0 || index + 1 >= argc) {
      fprintf(stderr, "landlock-sandbox: malformed rule arguments\n");
      close(ruleset_fd);
      return 64;
    }
    add_path_rule(ruleset_fd, handled, token + 2, argv[index + 1]);
    index += 1;
  }
  if (index >= argc) {
    fprintf(stderr, "landlock-sandbox: missing command after --\n");
    close(ruleset_fd);
    return 64;
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "landlock-sandbox: cannot set no_new_privs: %s\n", strerror(errno));
    close(ruleset_fd);
    return 70;
  }
  if (ll_restrict_self(ruleset_fd, 0) != 0) {
    fprintf(stderr, "landlock-sandbox: cannot restrict self: %s\n", strerror(errno));
    close(ruleset_fd);
    return 70;
  }
  close(ruleset_fd);

  execvp(argv[index], argv + index);
  fprintf(stderr, "landlock-sandbox: exec of %s failed: %s\n", argv[index], strerror(errno));
  return 71;
}
