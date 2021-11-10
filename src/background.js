'use strict';

import { app, protocol, BrowserWindow, ipcMain, dialog } from 'electron';
import knex from 'knex';
import Event from '@/Event';
import Logger from '@/Logger';
import AlertType from '@/AlertType';
import database from '@/util/database';
import { downloadYoutube } from '@/util/youtube';
import { getImage } from '@/util/api';
import { writeMetaData } from '@/util/musicUtils';
import fs from 'fs';
import Util from '@/Util';
import { createProtocol } from 'vue-cli-plugin-electron-builder/lib';
import installExtension, { VUEJS_DEVTOOLS } from 'electron-devtools-installer';
import path from 'path';
import FileFilter from '@/FileFilter';
const isDevelopment = process.env.NODE_ENV !== 'production';
const isBuild = process.env.NODE_ENV === 'production';
app.commandLine.appendSwitch('disable-web-security');

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win;
let youtubeWindow;

const alertBuilder = () => {
  let alertId = 1;
  return (alertType, message) => {
    return { id: alertId++, alertType, message };
  };
};

const generateAlert = alertBuilder();

const registerYoutubeApiKey = () => {
  const youtubeKeyFilePath = getResourcePath('conf/config.json');
  const binaryData = fs.readFileSync(youtubeKeyFilePath);
  const config = JSON.parse(binaryData);
  return config;
};

const getResourcePath = (dir) => {
  const pathToDbFile = isBuild ? path.join(__dirname, `../${dir}`) : path.join(__dirname, dir);
  return pathToDbFile;
};

const logFilePath = getResourcePath('logs/debug.log');
const logPath = getResourcePath('logs');
if (!fs.existsSync(logPath)) {
  fs.mkdirSync(logPath);
}
const logger = new Logger(logFilePath, isBuild);
const config = registerYoutubeApiKey();
const db = knex({
  client: 'sqlite3',
  connection: {
    filename: getResourcePath('db/music.db')
  },
  useNullAsDefault: true
});

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { secure: true, standard: true } }]);

ipcMain.on(Event.EVENT_OPEN_YOUTUBE_WINDOW, (event, musicDetail) => {
  createYoutubeWindow(musicDetail).then(() => {
    logger.log('create Youtube Window complete!');
  });
});
ipcMain.on(Event.EVENT_INSERT_MUSIC, (event, data) => {
  const musicDetail = data.musicDetail;
  logger.debug(data);
  // const albumDetail = data.albumDetail;
  database.insertMusic(db, {
    bugsId: musicDetail.bugsId,
    songName: musicDetail.songName,
    youtubeId: musicDetail.youtubeId,
    artistName: musicDetail.artist[0],
    albumName: musicDetail.albumName,
    albumCoverImage: musicDetail.imgSrc,
    albumId: musicDetail.bugsId,
    duration: musicDetail.duration,
    lyrics: musicDetail.lyrics
  }).then(data => {
    logger.debug(data);
  }).catch(err => {
    logger.debug(err);
  });
  logger.debug(data);
});
ipcMain.on(Event.EVENT_SELECT_MUSIC, async (e, { page = 1, offset = 30 }) => {
  logger.debug('EVENT_SELECT_MUSIC');
  const totalCount = await database.selectMusicTotalCount(db);
  let musicList = await database.selectMusic(db, { page, offset });
  musicList = musicList.map(music => {
    music.percentage = 0;
    return music;
  });
  win.send(Event.EVENT_SELECT_MUSIC, { musicList, totalCount: totalCount[0].count });
});
ipcMain.on(Event.DELETE_STORED_MUSIC, (e, musicId) => {
  logger.debug('EVENT_DELETE_MUSIC');
  const deleteResult = database.deleteMusic(db, musicId);
  deleteResult.then(e => {
    win.send(Event.EVENT_REFRESH_ITEMS);
    logger.debug(`${e}`);
  });
});
ipcMain.on(Event.OPEN_FILE_DIALOG, e => {
  dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    .then(({ canceled, filePaths }) => {
      if (!canceled) {
        const filePath = filePaths[0];
        logger.debug(`dialog choose directgory ${filePath}`);
        win.send(Event.OPEN_FILE_DIALOG, filePath);
      }
    });
});

ipcMain.on(Event.DOWNLOAD_MUSIC, async (e, { id, downloadPath }) => {
  const youtubeProcessSender = (musicId, percentage) => {
    logger.debug(`${musicId} ${percentage} is sended`);
    win.send(Event.EVENT_SEND_DOWNLOAD_SONG_PROGRESS, { musicId, percentage });
  };
  youtubeProcessSender(id, 0);
  logger.debug('EVENT_SELECT_MUSIC');
  logger.debug(`music id ${id}`);
  const musicSaveSetting = await database.getSettingById(db, 1);
  logger.debug(musicSaveSetting);
  if (musicSaveSetting.value === 'true') {
    logger.debug('music exists!');
    const cachedMusicExists = await database.checkAlreadyDownloadedMusic(db, id);
    logger.debug(`cachedMusicExists ${cachedMusicExists}`);
    if (cachedMusicExists) {
      logger.debug('cached music exists!');
      const musicData = await database.selectCachedMusicDataById(db, id);
      const music = await database.selectMusicById(db, id);
      logger.debug(music);
      fs.writeFile(`${downloadPath}/${Util.generateMp3FileName(music.artistName, music.name)}`, musicData, () => {
        logger.debug('file write done!');
      });
      return;
    }
  }
  const music = await database.selectMusicById(db, id);
  logger.debug(music);
  const libPath = getResourcePath('lib');
  const mp3FilePath = `${downloadPath}/${music.youtubeId}.mp3`;
  const newMp3FilePath = `${downloadPath}/${Util.generateMp3FileName(music.artistName, music.name)}`;
  const result = await downloadYoutube(youtubeProcessSender, id, libPath, music.youtubeId, music.duration, downloadPath, music.youtubeId);
  const imageData = Buffer.from(await getImage(music.albumCoverImage), 'binary');
  youtubeProcessSender(id, 70);
  writeMetaData(mp3FilePath, music.name, music.artistName, music.albumName, imageData, music.lyrics, music.bugsId, music.youtubeId);
  youtubeProcessSender(id, 85);
  logger.debug(`download music ${music.name} result ${result}`);
  logger.debug(musicSaveSetting);
  if (musicSaveSetting.value === 'true') {
    logger.debug(mp3FilePath);
    await saveMusicFileIntoDatabase(mp3FilePath, id);
  }
  fs.renameSync(mp3FilePath, newMp3FilePath);
  youtubeProcessSender(id, 100);
});

ipcMain.on(Event.EVENT_EXPORT_MUSIC, async (e, location) => {
  console.log(location);
});

const saveMusicFileIntoDatabase = async (mp3FilePath, musicId) => {
  const mp3Data = await fs.readFileSync(mp3FilePath, {});
  logger.debug(`before compression ${mp3Data.length}`);
  const musicExists = await database.checkAlreadyDownloadedMusic(db, musicId);
  if (!musicExists) {
    const insertResult = await database.insertDownloadMusicData(db, musicId, mp3Data);
    logger.debug(insertResult);
  } else {
    const updateResult = await database.updateMusicData(db, musicId, mp3Data);
    logger.debug(updateResult);
  }
};
const exportMusicData = (db) => {
  return database.selectAllMusic(db);
};
const writeJsonDataToFile = (path, data) => {
  fs.writeFile(path, JSON.stringify(data), (err) => {
    return new Promise((resolve, reject) => {
      if (err) reject(new Error(err));
      resolve();
    });
  });
};
ipcMain.on(Event.INIT_CONFIG, () => {
  win.send(Event.INIT_CONFIG, config);
});

ipcMain.on(Event.EVENT_MUSIC_BACKUP_REQUEST, async (backupPath) => {
  await backupMusicDatabase(db, backupPath);
});
ipcMain.on(Event.EVENT_FETCH_SETTINGS, async () => {
  try {
    const settings = await database.selectSettings(db);
    logger.debug('fetch settings');
    logger.debug(settings);
    win.send(Event.EVENT_FETCH_SETTINGS, settings);
  } catch (e) {
    logger.debug(e, '');
  }
});
ipcMain.on(Event.EVENT_UPDATE_SETTING, async (e, setting) => {
  try {
    await database.updateSetting(db, setting);
  } catch (e) {
    logger.debug(e, '');
  }
});
ipcMain.on(Event.EVENT_EXPORT_MUSIC, (e, musics) => {
  openFileSaveDialog().then(async path => {
    return { path, musics: await exportMusicData(db) };
  }).then(({ path, musics }) => writeJsonDataToFile(path, musics))
    .then(() => {
      const alert = generateAlert(AlertType.SUCCESS, 'data export success!');
      logger.debug(`alert ${alert.id} send`);
      win.send(Event.EVENT_GLOBAL_ALERT, alert);
    }).catch(err => {
      logger.debug(err);
      const errorAlert = generateAlert(AlertType.ERROR, err.message);
      win.send(Event.EVENT_GLOBAL_ALERT, errorAlert);
    });
  // exportMusicData(db);
});
ipcMain.on(Event.EVENT_IMPORT_MUSIC, () => {
  openFileOpenDialog().then(({ filePaths }) => {
    return filePaths.pop();
  }).then(filePath => {
    return fs.readFileSync(filePath, {});
  }).then(buffer => {
    const musics = JSON.parse(buffer.toString());
    const result = importMusic(musics);
    logger.debug(result);
    const alert = generateAlert(AlertType.SUCCESS, 'data import success!');
    win.send(Event.EVENT_GLOBAL_ALERT, alert);
  }).catch(err => {
    logger.debug(err);
  });
});

const importMusic = async (musics) => {
  const result = await database.importMusic(db, musics);
  return result;
};

const backupMusicDatabase = async (db, backupPath) => {
  const fileName = 'backup.json';
  const musicList = await database.selectAllMusic(db);
  fs.writeFile(path.join(backupPath, fileName), musicList, (err) => {
    if (err) throw err;
    logger.debug('The file has been saved!');
  });
};
const openFileSaveDialog = () => {
  return dialog.showSaveDialog(win, { message: 'select export file', filters: [FileFilter.json] })
    .then(({ canceled, filePath }) => {
      return new Promise((resolve, reject) => {
        if (canceled) reject(new Error('file select canceled'));
        logger.debug(`dialog choose directory ${filePath}`);
        resolve(filePath);
      });
    });
};
const openFileOpenDialog = () => {
  return dialog.showOpenDialog(win, { filters:[FileFilter.json], properties: ['openFile'] });
};
const createYoutubeWindow = async (musicId) => {
  if (!youtubeWindow) {
    youtubeWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      webPreferences: {
        nodeIntegration: true,
        webSecurity: false,
        webviewTag: true
      }
    });
  } else {
    youtubeWindow.focus();
  }
  if (process.env.WEBPACK_DEV_SERVER_URL) {
    // Load the url of the dev server if in development mode
    await youtubeWindow.loadURL(`${process.env.WEBPACK_DEV_SERVER_URL}#/youtube?appBar=false&menu=false`);
    if (!process.env.IS_TEST) youtubeWindow.webContents.openDevTools();
  } else {
    createProtocol('app');
    // Load the index.html when not in development
    await youtubeWindow.loadURL('app://./index.html#youtube?appBar=false&menu=false').then(() => logger.debug('load success')).catch(err => logger.debug(err));
  }
  youtubeWindow.on('closed', () => {
    logger.debug('youtube window closed');
    youtubeWindow = null;
  });
  youtubeWindow.webContents.once('dom-ready', () => {
    youtubeWindow.webContents.send(Event.EVENT_SET_MUSIC_DETAIL, musicId);
  });
};

const createWindow = async () => {
  // Create the browser window.
  /* global __static */
  logger.debug('create main window');
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      webSecurity: false
    },
    icon: path.join(__static, 'icon.png')
  });
  if (process.env.WEBPACK_DEV_SERVER_URL) {
    // Load the url of the dev server if in development mode
    await win.loadURL(`${process.env.WEBPACK_DEV_SERVER_URL}`);
    if (!process.env.IS_TEST) win.webContents.openDevTools();
  } else {
    createProtocol('app');
    // Load the index.html when not in development
    await win.loadURL('app://./index.html');
  }

  win.on('closed', () => {
    win = null;
    if (youtubeWindow) {
      youtubeWindow.close();
      youtubeWindow = null;
    }
  });
};
// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (win === null) {
    await createWindow();
  }
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  if (isDevelopment && !process.env.IS_TEST) {
    // Install Vue Devtools
    // Devtools extensions are broken in Electron 6.0.0 and greater
    // See https://github.com/nklayman/vue-cli-plugin-electron-builder/issues/378 for more info
    // Electron will not launch with Devtools extensions installed on Windows 10 with dark mode
    // If you are not using Windows 10 dark mode, you may uncomment these lines
    // In addition, if the linked issue is closed, you can upgrade electron and uncomment these lines
    try {
      await installExtension(VUEJS_DEVTOOLS);
    } catch (e) {
      console.error('Vue Devtools failed to install:', e.toString());
    }
  }
  createWindow().then(() => {
    win.send(Event.INIT_CONFIG, config);
  });
});

// Exit cleanly on request from parent process in development mode.
if (isDevelopment) {
  if (process.platform === 'win32') {
    process.on('message', data => {
      if (data === 'graceful-exit') {
        app.quit();
      }
    });
  } else {
    process.on('SIGTERM', () => {
      app.quit();
    });
  }
}
