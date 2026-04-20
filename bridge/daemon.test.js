'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// REEL_DIR을 임시 디렉토리로 오버라이드
const TEST_DIR = path.join(os.tmpdir(), 'reel-test-' + process.pid);
process.env.REEL_DIR = TEST_DIR;

const daemon = require('./daemon');

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.REEL_DIR;
});

describe('getPid', () => {
  test('PID 파일 없으면 null 반환', () => {
    expect(daemon.getPid()).toBeNull();
  });

  test('PID 파일 있으면 숫자 반환', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'server.pid'), '12345', 'utf8');
    expect(daemon.getPid()).toBe(12345);
  });
});

describe('writePid / clearPid', () => {
  test('writePid가 PID 파일을 생성하고 clearPid가 삭제한다', () => {
    daemon.writePid(9999);
    expect(daemon.getPid()).toBe(9999);
    daemon.clearPid();
    expect(daemon.getPid()).toBeNull();
  });
});

describe('isRunning', () => {
  test('현재 프로세스 PID는 실행 중으로 판단', () => {
    expect(daemon.isRunning(process.pid)).toBe(true);
  });

  test('존재하지 않는 PID는 실행 중 아님으로 판단', () => {
    expect(daemon.isRunning(999999999)).toBe(false);
  });
});
