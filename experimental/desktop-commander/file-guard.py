#!/usr/bin/env python3
"""Pinned-directory, bounded snapshots and optimistic guarded text replacement.

Open directory components with O_NOFOLLOW and dir_fd; never follow model paths
outside the selected root. This is not an atomic CAS against uncooperative editors.
"""
import base64, hashlib, json, os, stat, sys, time, uuid

LIMIT = 1024 * 1024
BACKUP_LIMIT = 64 * 1024 * 1024

class Refusal(Exception):
    pass

def parent(root, path):
    parts = path.split('/')
    if path.startswith('/') or any(x in ('', '..') for x in parts) or '\\' in path:
        raise Refusal('PATH_DENIED')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    chain = []
    try:
        for name in ['.'] + parts[:-1]:
            if name != '.':
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = child
            s = os.fstat(fd); chain.append([s.st_dev, s.st_ino])
        return fd, parts[-1], chain
    except BaseException:
        os.close(fd); raise

def signature(s):
    return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode, s.st_nlink, s.st_uid, s.st_gid]

def snapshot(fd, name, chain):
    try:
        f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return dict(revision=None, data='', size=0, mode=0o600, uid=os.geteuid(), gid=os.getegid(), xattrs={})
    try:
        before = os.fstat(f)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise Refusal('REGULAR_SINGLE_LINK_FILE_REQUIRED')
        if before.st_size > LIMIT: raise Refusal('FILE_SNAPSHOT_TOO_LARGE')
        data = bytearray()
        while len(data) <= LIMIT:
            chunk = os.read(f, min(65536, LIMIT + 1 - len(data)))
            if not chunk: break
            data.extend(chunk)
        if len(data) > LIMIT: raise Refusal('FILE_SNAPSHOT_TOO_LARGE')
        attrs = {key: base64.b64encode(os.getxattr(f, key)).decode() for key in os.listxattr(f)}
        if sum(len(v) for v in attrs.values()) > 65536: raise Refusal('FILE_METADATA_TOO_LARGE')
        if signature(before) != signature(os.fstat(f)): raise Refusal('FILE_CHANGED_DURING_READ')
        data.decode('utf-8')
        if b'\x00' in data: raise Refusal('TEXT_FILE_REQUIRED')
        fingerprint = json.dumps([chain, signature(before), hashlib.sha256(data).hexdigest(), attrs], separators=(',', ':'), sort_keys=True)
        return dict(revision='file-v1:' + hashlib.sha256(fingerprint.encode()).hexdigest(),
                    data=base64.b64encode(data).decode(), size=len(data), mode=stat.S_IMODE(before.st_mode),
                    uid=before.st_uid, gid=before.st_gid, xattrs=attrs)
    finally:
        os.close(f)

def write_all(fd, data):
    remaining = memoryview(data)
    while remaining:
        count = os.write(fd, remaining)
        if count <= 0: raise OSError('SHORT_WRITE')
        remaining = remaining[count:]
    os.fsync(fd)

def main(args):
    fd, name, chain = parent(args['root'], args['path'])
    temporary = None; committed = False
    try:
        current = snapshot(fd, name, chain)
        if args['action'] == 'snapshot': return dict(ok=True, **current)
        if args['action'] != 'commit': raise Refusal('ACTION_DENIED')
        if current['revision'] != args['expectedRevision']: raise Refusal('FILE_VERSION_CONFLICT')
        if current['revision'] and not current['mode'] & 0o200: raise Refusal('FILE_NOT_WRITABLE')
        if current['mode'] & 0o6000 or any(k.startswith('security.') for k in current['xattrs']):
            raise Refusal('PRIVILEGED_FILE_METADATA_UNSUPPORTED')
        content = base64.b64decode(args['content'], validate=True)
        if len(content) > LIMIT: raise Refusal('FILE_SNAPSHOT_TOO_LARGE')
        content.decode('utf-8')
        backup_id = args['backupId']
        if len(backup_id) != 64 or any(c not in '0123456789abcdef' for c in backup_id): raise Refusal('BACKUP_ID_DENIED')
        os.makedirs(args['backupRoot'], mode=0o700, exist_ok=True)
        bfd = os.open(args['backupRoot'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            used = sum(os.stat(n, dir_fd=bfd, follow_symlinks=False).st_size for n in os.listdir(bfd))
            encoded = json.dumps(dict(path=args['path'], before=current, createdAt=time.time())).encode()
            if used + len(encoded) > BACKUP_LIMIT: raise Refusal('FILE_BACKUP_STORAGE_FULL')
            try:
                backup = os.open(backup_id + '.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=bfd)
            except FileExistsError:
                return dict(ok=False, uncertain=True, error='PRIOR_COMMIT_REQUIRES_REVIEW')
            try: write_all(backup, encoded)
            finally: os.close(backup)
            os.fsync(bfd)
        finally: os.close(bfd)
        temporary = '.anywhere-stage-' + uuid.uuid4().hex
        temp = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            os.fchown(temp, current['uid'], current['gid'])
            os.fchmod(temp, current['mode'] & 0o777)
            for key, value in current['xattrs'].items(): os.setxattr(temp, key, base64.b64decode(value))
            write_all(temp, content)
        finally: os.close(temp)
        check_fd, _, check_chain = parent(args['root'], args['path'])
        try:
            if chain != check_chain or snapshot(check_fd, name, check_chain)['revision'] != args['expectedRevision']:
                raise Refusal('FILE_VERSION_CONFLICT')
        finally: os.close(check_fd)
        # For a new path, link is atomic create-if-absent. Existing paths use
        # compare-before-replace, with a retained preimage; no filesystem CAS claim.
        if current['revision'] is None:
            try: os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
            except FileExistsError: raise Refusal('FILE_VERSION_CONFLICT')
            committed = True; os.unlink(temporary, dir_fd=fd); temporary = None
        else:
            os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd); committed = True; temporary = None
        os.fsync(fd)
        after = snapshot(fd, name, chain)
        if after['data'] != args['content']:
            return dict(ok=False, uncertain=True, error='FILE_CHANGED_AFTER_COMMIT', backupId=backup_id)
        return dict(ok=True, revision=after['revision'], size=after['size'], backupId=backup_id,
                    protection='optimistic-version-check-with-preimage')
    except (Refusal, OSError, UnicodeError, ValueError) as error:
        return dict(ok=False, uncertain=committed, error=str(error) if isinstance(error, Refusal) else type(error).__name__)
    finally:
        if temporary:
            try: os.unlink(temporary, dir_fd=fd)
            except FileNotFoundError: pass
        os.close(fd)

try:
    request = json.loads(sys.stdin.buffer.read(3 * LIMIT))
    result = main(request)
except (Refusal, OSError, UnicodeError, ValueError, KeyError) as error:
    result = dict(ok=False, uncertain=False, error=str(error) if isinstance(error, Refusal) else type(error).__name__)
print(json.dumps(result))
