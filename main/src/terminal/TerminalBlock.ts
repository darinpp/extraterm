/*
 * Copyright 2022 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import { QPainter, QWidget, QPaintEvent, WidgetEventTypes, QMouseEvent, MouseButton, KeyboardModifier, CompositionMode,
  QPen,
  ContextMenuPolicy,
  QRect,
  QColor} from "@nodegui/nodegui";
import { getLogger, log, Logger } from "extraterm-logging";
import { Disposable, Event } from "extraterm-event-emitter";
import { normalizedCellIterator, NormalizedCell, TextureFontAtlas, RGBAToQColor, TextureCachedGlyph, FontSlice,
  CursorStyle, MonospaceFontMetrics } from "extraterm-char-render-canvas";
import { STYLE_MASK_CURSOR, STYLE_MASK_HYPERLINK_HIGHLIGHT, STYLE_MASK_INVERSE } from "extraterm-char-cell-line";
import { Color } from "extraterm-color-utilities";
import { EventEmitter } from "extraterm-event-emitter";
import { countCells, reverseString } from "extraterm-unicode-utilities";
import { BlockMetadata, BlockPosture } from "@extraterm/extraterm-extension-api";
import { Line, MouseEventOptions, RenderEvent, TerminalCoord } from "term-api";
import { LineImpl } from "term-api-lineimpl";

import { Block } from "./Block.js";
import * as Term from "../emulator/Term.js";
import { PALETTE_BG_INDEX, PALETTE_CURSOR_INDEX, TerminalVisualConfig } from "./TerminalVisualConfig.js";
import { ConfigCursorStyle } from "../config/Config.js";
import { FontAtlasCache } from "./FontAtlasCache.js";
import { BlobBulkFile } from "../bulk_file_handling/BlobBulkFile.js";
import { BulkFile } from "../bulk_file_handling/BulkFile.js";


enum SelectionMode {
  NORMAL,
  BLOCK
};

const WORD_SELECTION_REGEX = new RegExp("^[\\p{L}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}\\$_@~?&=%#/:\\\\.-]+", "ug");

interface ExpandedMouseEventOptions extends MouseEventOptions {
  nearestColumnEdge: number;
}

export interface AppendScrollbackLinesDetail {
  startLine: number;
  endLine: number;
}

/**
 * Shows the contents of a terminal and can accept input.
 */
export class TerminalBlock implements Block {
  private _log: Logger = null;

  #parent: any = null;
  #widget: QWidget = null;
  #emulator: Term.Emulator = null;
  #preeditString: string = null;

  #columns = 0;

  #onRenderDispose: Disposable =null;
  #terminalVisualConfig: TerminalVisualConfig = null;
  #fontSlices: FontSlice[] = [];

  #fontAtlasCache: FontAtlasCache = null;
  #fontAtlas: TextureFontAtlas = null;
  #heightPx = 1;
  #fontMetrics: MonospaceFontMetrics = null;
  #extraFontMetrics: MonospaceFontMetrics[] = [];

  #scrollback: Line[] = [];

  #selectionStart: TerminalCoord = null;
  #selectionEnd: TerminalCoord = null;
  #selectionMode = SelectionMode.NORMAL;
  #isWordSelection = false;

  #onDidAppendScrollbackLinesEventEmitter = new EventEmitter<AppendScrollbackLinesDetail>();
  onDidAppendScrollbackLines: Event<AppendScrollbackLinesDetail>;

  #onHyperlinkClickedEventEmitter = new EventEmitter<string>();
  onHyperlinkClicked: Event<string>;

  #onHyperlinkHoverEventEmitter = new EventEmitter<string>();
  onHyperlinkHover: Event<string>;

  #onSelectionChangedEventEmitter = new EventEmitter<void>();
  onSelectionChanged: Event<void>;

  #hoveredURL: string = null;
  #hoveredGroup: string = null;

  #metadataChangedEventEmitter = new EventEmitter<void>();
  onMetadataChanged: Event<void>;

  #returnCode: number = null;
  #commandLine: string = null;

  constructor(fontAtlasCache: FontAtlasCache) {
    this._log = getLogger("TerminalBlock", this);
    this.#fontAtlasCache = fontAtlasCache;
    this.onDidAppendScrollbackLines = this.#onDidAppendScrollbackLinesEventEmitter.event;
    this.onHyperlinkClicked = this.#onHyperlinkClickedEventEmitter.event;
    this.onHyperlinkHover = this.#onHyperlinkHoverEventEmitter.event;
    this.onSelectionChanged = this.#onSelectionChangedEventEmitter.event;
    this.onMetadataChanged = this.#metadataChangedEventEmitter.event;

    this.#widget = this.#createWidget();
  }

  dispose(): void {
  }

  #createWidget(): QWidget {
    const widget = new QWidget();
    widget.setObjectName(this._log.getName());
    widget.setContextMenuPolicy(ContextMenuPolicy.PreventContextMenu);

    widget.setMaximumSize(16777215, this.#heightPx);
    widget.setMouseTracking(true);

    widget.addEventListener(WidgetEventTypes.Paint, (nativeEvent) => {
      this.#handlePaintEvent(new QPaintEvent(nativeEvent));
    });
    widget.addEventListener(WidgetEventTypes.MouseButtonPress, (nativeEvent) => {
      this.#handleMouseButtonPress(new QMouseEvent(nativeEvent));
    });
    widget.addEventListener(WidgetEventTypes.MouseButtonRelease, (nativeEvent) => {
      this.#handleMouseButtonRelease(new QMouseEvent(nativeEvent));
    });
    widget.addEventListener(WidgetEventTypes.MouseButtonDblClick, (nativeEvent) => {
      this.#handleMouseDoubleClick(new QMouseEvent(nativeEvent));
    });
    widget.addEventListener(WidgetEventTypes.MouseMove, (nativeEvent) => {
      this.#handleMouseMove(new QMouseEvent(nativeEvent));
    });

    return widget;
  }

  setParent(parent: any): void {
    this.#parent = parent;
  }

  getParent(): any {
    return this.#parent;
  }

  getWidget(): QWidget {
    return this.#widget;
  }

  getScrollbackLength(): number {
    return this.#scrollback.length;
  }

  getEmulator(): Term.Emulator {
    return this.#emulator;
  }

  hasSelection(): boolean {
    return this.#selectionStart != null && this.#selectionEnd != null;
  }

  clearSelection(): void {
    if (!this.hasSelection()) {
      return;
    }
    this.#selectionStart = null;
    this.#selectionEnd = null;
    this.#widget.update();
  }

  setPreeditString(text: string): void {
    this.#preeditString = text;
    this.#widget.update();
  }

  takeScrollbackFrom(startLine: number): Line[] {
    const result = this.#scrollback.slice(startLine);
    this.#scrollback.splice(startLine);
    this.#updateWidgetSize();
    this.#widget.update();
    return result;
  }

  setScrollbackLines(scrollbackLines: Line[]): void {
    this.#scrollback = scrollbackLines;
    this.#updateWidgetSize();
    this.#widget.update();
  }

  setTerminalVisualConfig(terminalVisualConfig: TerminalVisualConfig): void {
    this.#terminalVisualConfig = terminalVisualConfig;

    const fontAtlasInfo = this.#fontAtlasCache.get(terminalVisualConfig);
    this.#fontAtlas = fontAtlasInfo.fontAtlas;
    this.#fontMetrics = fontAtlasInfo.metrics;
    this.#extraFontMetrics = fontAtlasInfo.extraMetrics;

    this.#fontSlices = terminalVisualConfig.extraFonts;
    this.#updateWidgetSize();
  }

  getScreenWidth(): number {
    return this.#columns;
  }

  getScrollbackLineText(lineNumber: number): string {
    const line = this.#scrollback[lineNumber];
    if (line == null) {
      return null;
    }
    return line.getString(0);
  }

  getScrollbackLineAtRow(rowNumber: number): Line {
    const line = this.#scrollback[rowNumber];
    if (line == null) {
      return null;
    }
    return line;
  }

  isScrollbackLineWrapped(lineNumber: number): boolean {
    const line = this.#scrollback[lineNumber];
    if (line == null) {
      return null;
    }
    return line.isWrapped;
  }

  applyScrollbackHyperlink(lineNumber: number, x: number, length: number, url: string, group: string=""): void {
    const line = this.#scrollback[lineNumber];
    const startColumn = line.mapStringIndexToColumn(x);
    const endColumn = line.mapStringIndexToColumn(x + length);

    this.#applyHyperlinkAtTextCoordinates(lineNumber, startColumn, endColumn - startColumn,
      url, group);
    this.#widget.update();
  }

  #applyHyperlinkAtTextCoordinates(row: number, column: number, length: number, url: string, group: string=""): void {
    const line = this.#scrollback[row];
    const linkID = line.getOrCreateLinkIDForURL(url, group);
    for (let i = 0; i < length; i++) {
      line.setLinkID(column + i, linkID);
    }
  }

  removeHyperlinks(lineNumber: number, group: string=""): boolean {
    const line = this.#scrollback[lineNumber];
    const width = line.width;
    let didRemove = false;
    if (group === "") {
      for (let i=0; i<width; i++) {
        const linkID = line.getLinkID(i);
        if (linkID !== 0) {
          line.setLinkID(i, 0);
          didRemove = true;
        }
      }

    } else {
      const targetLinkIDs = line.getAllLinkIDs(group);
      if (targetLinkIDs.length !== 0) {
        for (let i=0; i<width; i++) {
          const linkID = line.getLinkID(i);
          if (targetLinkIDs.includes(linkID)) {
            line.setLinkID(i, 0);
            didRemove = true;
          }
        }
      }
    }

    if (didRemove) {
      this.#widget.update();
    }

    return didRemove;
  }

  deleteScrollbackLayers(): void {
    for (const line of this.#scrollback) {
      line.layers = [];
    }
  }

  #updateWidgetSize(): void {
    if (this.#terminalVisualConfig == null || this.#fontMetrics == null) {
      return;
    }

    const metrics = this.#fontMetrics;
    let materializedRows = 0;
    if (this.#emulator != null) {
      const dims = this.#emulator.getDimensions();
      materializedRows = dims.materializedRows;
      this.#columns = dims.cols;
    }
    const dpr = this.#terminalVisualConfig.windowDpr;
    const newHeightPx = Math.ceil((materializedRows + this.#scrollback.length) * metrics.heightPx / dpr);
    if (newHeightPx === this.#heightPx) {
      return;
    }

    this.#widget.setMinimumSize(10 * metrics.widthPx / dpr, newHeightPx);
    this.#widget.setMaximumSize(16777215, newHeightPx);
    this.#heightPx = newHeightPx;
  }

  getCellWidthPx(): number {
    const dpr = this.#widget.devicePixelRatio();
    return this.#fontMetrics.widthPx / dpr;
  }

  getCellHeightPx(): number {
    const dpr = this.#widget.devicePixelRatio();
    return this.#fontMetrics.heightPx / dpr;
  }

  setEmulator(emulator: Term.Emulator): void {
    if (this.#emulator !== null) {
      // Disconnect the last emulator.
      this.#onRenderDispose.dispose();
      this.#onRenderDispose = null;
      this.#emulator = null;
    }

    if (emulator !== null) {
      this.#onRenderDispose = emulator.onRender(this.#handleRenderEvent.bind(this));
    }

    this.#emulator = emulator;
    this.#updateWidgetSize();
  }

  #handleRenderEvent(event: RenderEvent): void {
    const newScrollbackLength = this.#scrollback.length + event.scrollbackLines.length;
    this.#stompSelection(event.refreshStartRow + newScrollbackLength, event.refreshEndRow + newScrollbackLength);

    this.#updateWidgetSize();

    if (event.scrollbackLines.length !== 0) {
      const startLine = this.#scrollback.length;
      this.#scrollback.splice(startLine, 0, ...event.scrollbackLines);
      this.#updateWidgetSize();

      const endLine = startLine + event.scrollbackLines.length;
      this.#onDidAppendScrollbackLinesEventEmitter.fire({ startLine, endLine });
    }

    this.#widget.update();
  }

  #stompSelection(startRow: number, endRow: number): void {
    if ( ! this.hasSelection()) {
      return;
    }

    if (this.#selectionEnd.y < startRow || this.#selectionStart.y >= endRow) {
      return;
    }
    this.clearSelection();
  }

  #toRealPixels(logicalPx: number): number {
    return this.#widget.devicePixelRatio() * logicalPx;
  }

  #toLogicalPixels(logicalPx: number): number {
    return logicalPx / this.#widget.devicePixelRatio();
  }

  #handlePaintEvent(event: QPaintEvent): void {
    const paintRect = event.rect();

    const metrics = this.#fontMetrics;
    const heightPx = metrics.heightPx;

    const topRenderRow = Math.floor(this.#toRealPixels(paintRect.top()) / heightPx);
    const heightRows = Math.ceil(this.#toRealPixels(paintRect.height()) / heightPx) + 1;

    const painter = new QPainter(this.#widget);
    const cursorStyle = this.#terminalVisualConfig.cursorStyle;

    const bgRGBA = this.#terminalVisualConfig.palette[PALETTE_BG_INDEX];
    painter.fillRectF(paintRect.left(), paintRect.top(), paintRect.width(), paintRect.height(), RGBAToQColor(bgRGBA));

    // Render any lines from the scrollback
    const scrollbackLength = this.#scrollback.length;
    if (topRenderRow < scrollbackLength) {
      const lastRenderRow = Math.min(topRenderRow + heightRows, scrollbackLength);
      const lines = this.#scrollback.slice(topRenderRow, lastRenderRow);
      const startY = topRenderRow * heightPx;
      this.#renderLines(painter, lines, startY, false);
      this.#renderCursors(painter, lines, startY);
    }

    // Render any lines from the emulator screen
    if (topRenderRow + heightRows >= scrollbackLength && this.#emulator != null) {
      const emulatorDimensions = this.#emulator.getDimensions();
      const screenTopRow = Math.max(topRenderRow, scrollbackLength) - scrollbackLength;
      const screenLastRow = Math.min(topRenderRow + heightRows - scrollbackLength, emulatorDimensions.materializedRows);

      const lines: Line[] = [];
      for (let i = screenTopRow; i < screenLastRow; i++) {
        const line = this.#emulator.lineAtRow(i);
        lines.push(line);
      }
      const startY = (screenTopRow + scrollbackLength) * heightPx;
      this.#renderLines(painter, lines, startY, cursorStyle === "block");
      this.#renderCursors(painter, lines, startY);
      this.#renderPreexitString(painter);
    }

    this.#renderSelection(painter, topRenderRow, heightRows);

    painter.end();
  }

  #renderSelection(painter: QPainter, topRenderRow: number, heightRows: number): void {
    const metrics = this.#fontMetrics;
    const dpr = this.#widget.devicePixelRatio();
    const heightPx = metrics.heightPx / dpr;
    const widthPx = metrics.widthPx / dpr;

    let selectionStart = this.#selectionStart;
    let selectionEnd = this.#selectionEnd;

    if (selectionStart == null || selectionEnd == null || terminalCoordEqual(selectionStart, selectionEnd)) {
      return;
    }

    if ( ! terminalCoordLessThan(selectionStart, selectionEnd)) {
      selectionStart = this.#selectionEnd;
      selectionEnd = this.#selectionStart;
    }

    const selectionColor = this.#terminalVisualConfig.terminalTheme.selectionBackgroundColor;
    const selectionQColor = RGBAToQColor(new Color(selectionColor).toRGBA());
    const firstRow = Math.max(topRenderRow, selectionStart.y);
    const lastRow = Math.min(topRenderRow + heightRows + 1, selectionEnd.y + 1);

    const emulatorWidth = this.#emulator?.getDimensions().cols ?? 0;

    painter.setCompositionMode(CompositionMode.CompositionMode_Screen);

    if (this.#selectionMode === SelectionMode.NORMAL) {
      this.#renderNormalSelection(painter, selectionStart, selectionEnd, firstRow, lastRow, widthPx, heightPx,
        selectionQColor, emulatorWidth);
    } else {
      this.#renderBlockSelection(painter, selectionStart, selectionEnd, firstRow, lastRow, widthPx, heightPx,
        selectionQColor, emulatorWidth);
    }
  }

  #renderNormalSelection(painter: QPainter, selectionStart: TerminalCoord, selectionEnd: TerminalCoord,
      firstRow: number, lastRow: number, widthPx: number, heightPx: number, selectionQColor: QColor,
      emulatorWidth: number): void {

    for (let i=firstRow; i<lastRow; i++) {
      if (i === selectionStart.y) {
        if (selectionStart.y === selectionEnd.y) {
          // Small selection contained within one row.
          painter.fillRectF(selectionStart.x*widthPx, selectionStart.y*heightPx,
            (selectionEnd.x - selectionStart.x) * widthPx, heightPx, selectionQColor);
        } else {
          // Top row of the selection.
          let rowLength = emulatorWidth;
          if (i < this.#scrollback.length) {
            rowLength = this.#scrollback[i].width;
          }
          painter.fillRectF(selectionStart.x*widthPx, selectionStart.y*heightPx,
            (rowLength - selectionStart.x) * widthPx, heightPx, selectionQColor);
        }
      } else {
        if (i !== selectionEnd.y) {
          // A row within a multi-row selection.
          let rowLength = emulatorWidth;
          if (i < this.#scrollback.length) {
            rowLength = this.#scrollback[i].width;
          }
          painter.fillRectF(0, i*heightPx, rowLength*widthPx, heightPx, selectionQColor);
        } else {
          // The last row of a multi-row selection.
          painter.fillRectF(0, i*heightPx, selectionEnd.x*widthPx, heightPx, selectionQColor);
        }
      }
    }
  }

  #renderBlockSelection(painter: QPainter, selectionStart: TerminalCoord, selectionEnd: TerminalCoord,
      firstRow: number, lastRow: number, widthPx: number, heightPx: number, selectionQColor: QColor,
      emulatorWidth: number): void {

    const leftX = selectionStart.x;
    const rightX = selectionEnd.x;

    for (let i=firstRow; i<lastRow; i++) {
      // A row within a multi-row selection.
      let rowLength: number;
      if (i < this.#scrollback.length) {
        rowLength = Math.min(this.#scrollback[i].width, rightX);
      } else {
        rowLength = Math.min(emulatorWidth, rightX);
      }
      painter.fillRectF(leftX*widthPx, i*heightPx,
        (rowLength - leftX) * widthPx, heightPx, selectionQColor);
    }
  }

  #renderLines(painter: QPainter, lines: Line[], startY: number, renderCursor: boolean): void {
    const metrics = this.#fontMetrics;
    const heightPx = metrics.heightPx;

    let yCounter = 0;
    for (const line of lines) {
      const y = startY + yCounter * heightPx + (1/128); // About 1/128, see below.
      this.#renderSingleLine(painter, line, y, renderCursor);
      for (const layer of line.layers) {
        this.#renderSingleLine(painter, layer.line, y, renderCursor);
      }
      yCounter++;
    }

    // What is the extra 1/128?
    //
    // This is related to HiDPI and rounding errors. We want to render pixel
    // perfect images and therefore compute most things in pixel coordinate
    // space and then adjust for the Device Pixel Ratio. (i.e. px / dpr). On
    // the drawing side Qt will then multiple by DPR to get from the logical
    // coordinate space to real pixels before rendering. But in some
    // situations this divide by DPR and then multiple DPR doesn't get us the
    // pixel value we wanted. Some floating point rounding errors creep in.
    // For example: pixel value 1302 with DPR=1.25 results in a render at 1
    // pixel higher than desired. After the multiply the value is ever so
    // slightly less than 1302 and gets round to an integer, the wrong
    // integer. To counter act this effect, we add a small offset, 1/128,
    // which counter acts the error just enough to get the right integer
    // result.
    //
    // But why 1/128 in particular?
    //
    // Internal Qt uses fixed point math for drawing with 6 bits in the
    // fractional part. This gives us a resolution of 1/64. Conversion to
    // fixed point happens late in the process. Add 1/128 gets us the correct
    // answer but gets effectively removed during the conversion to fixed
    // point.
  }

  #renderSingleLine(painter: QPainter, line: Line, y: number, renderCursor: boolean): void {
    const qimage = this.#fontAtlas.getQImage();
    const metrics= this.#fontMetrics;
    const widthPx = metrics.widthPx;
    const heightPx = metrics.heightPx;
    const palette = this.#terminalVisualConfig.palette;
    const ligatureMarker = this.#terminalVisualConfig.ligatureMarker;
    const cursorColor = this.#terminalVisualConfig.palette[PALETTE_CURSOR_INDEX];
    const normalizedCell: NormalizedCell = {
      x: 0,
      segment: 0,
      codePoint: 0,
      extraFontFlag: false,
      isLigature: false,
      ligatureCodePoints: null,
      linkID: 0,
    };

    line.setPalette(palette); // TODO: Maybe the palette should pushed up into the emulator.
    this.#updateCharGridFlags(line);

    if (ligatureMarker != null) {
      const text = line.getString(0);
      ligatureMarker.markLigaturesCharCellLine(line, text);
    }

    let hoverLinkID = 0;
    if (this.#hoveredURL != null) {
      hoverLinkID = line.getLinkIDByURL(this.#hoveredURL, this.#hoveredGroup);
    }

    const dpr = this.#toRealPixels(1);

    let xPx = 0;
    for (const column of normalizedCellIterator(line, normalizedCell)) {
      const codePoint = normalizedCell.codePoint;
      if (codePoint !== 0) {
        const fontIndex = normalizedCell.extraFontFlag ? 1 : 0;

        let fgRGBA = line.getFgRGBA(column);
        let bgRGBA = line.getBgRGBA(column);

        let style = line.getStyle(column);
        if ((style & STYLE_MASK_CURSOR) && renderCursor) {
          fgRGBA = bgRGBA;
          bgRGBA = cursorColor;
        } else {
          if (style & STYLE_MASK_INVERSE) {
            const tmp = fgRGBA;
            fgRGBA = bgRGBA;
            bgRGBA = tmp;
          }
        }
        fgRGBA |= 0x000000ff;

        if ((hoverLinkID !== 0) && (normalizedCell.linkID === hoverLinkID)) {
          style |= STYLE_MASK_HYPERLINK_HIGHLIGHT;
        }

        let glyph: TextureCachedGlyph;
        if (normalizedCell.isLigature) {
          glyph = this.#fontAtlas.loadCombiningCodePoints(normalizedCell.ligatureCodePoints, style,
            fontIndex, fgRGBA, bgRGBA);
        } else {
          glyph = this.#fontAtlas.loadCodePoint(codePoint, style, fontIndex, fgRGBA, bgRGBA);
        }
        qimage.setDevicePixelRatio(dpr);
        const sourceX = glyph.xPixels + normalizedCell.segment * glyph.widthPx;
        const sourceY = glyph.yPixels;
        painter.drawImageF(xPx / dpr, y / dpr, qimage, sourceX, sourceY, glyph.widthPx, heightPx);
      }
      xPx += widthPx;
    }
  }

  #updateCharGridFlags(line: Line): void {
    const width = line.width;
    const fontSlices = this.#fontSlices;
    for (let i=0; i<width; i++) {
      const codePoint = line.getCodePoint(i);
      let isExtra = false;
      for (const fontSlice of fontSlices) {
        if (fontSlice.containsCodePoint(codePoint)) {
          line.setExtraFontsFlag(i, true);
          isExtra = true;
          break;
        }
      }
      line.setExtraFontsFlag(i, isExtra);
      line.setLigature(i, 0);
    }
  }

  getCursorGeometry(): QRect | null {
    if (this.#emulator == null) {
      return null;
    }
    const dim = this.#emulator.getDimensions();

    const metrics= this.#fontMetrics;
    const cellHeightPx = this.#toLogicalPixels(metrics.heightPx);
    const cellWidthPx = this.#toLogicalPixels(metrics.widthPx);

    const xPx = dim.cursorX * cellWidthPx;
    const yPx = (dim.cursorY + this.#scrollback.length) * cellHeightPx;
    return new QRect(xPx, yPx, cellWidthPx, cellHeightPx);
  }

  #renderCursors(painter: QPainter, lines: Line[], startY: number): void {
    const cursorStyle = this.#configCursorStyleToRendererCursorStyle(this.#terminalVisualConfig.cursorStyle);
    if (cursorStyle === CursorStyle.BLOCK) {
      return;
    }

    const metrics= this.#fontMetrics;
    const cellHeightPx = this.#toLogicalPixels(metrics.heightPx);
    const cellWidthPx = this.#toLogicalPixels(metrics.widthPx);

    const cursorColor = RGBAToQColor(this.#terminalVisualConfig.palette[PALETTE_CURSOR_INDEX]);
    const pen = new QPen();
    pen.setColor(cursorColor);
    const outlinePenWidthPx = 1;
    pen.setWidth(outlinePenWidthPx);
    painter.setPen(pen);

    let y = startY;
    for (const line of lines) {
      const width = line.width;
      for (let i=0; i<width; i++) {
        if (line.getStyle(i) & STYLE_MASK_CURSOR) {
          switch (cursorStyle) {
            case CursorStyle.BLOCK_OUTLINE:
              painter.drawRectF(i * cellWidthPx + outlinePenWidthPx, y + outlinePenWidthPx,
                cellWidthPx - 2 * outlinePenWidthPx, cellHeightPx - 2 * outlinePenWidthPx);
              break;

            case CursorStyle.UNDERLINE:
              painter.fillRectF(i * cellWidthPx, y + cellHeightPx-3, cellWidthPx, 3, cursorColor);
              break;

            case CursorStyle.UNDERLINE_OUTLINE:
              painter.drawRectF(i * cellWidthPx + outlinePenWidthPx, y + cellHeightPx - 2*outlinePenWidthPx,
                cellWidthPx-outlinePenWidthPx, 2);
              break;

            case CursorStyle.BEAM:
              painter.fillRectF(i * cellWidthPx, y, 2, cellHeightPx, cursorColor);
              break;

            case CursorStyle.BEAM_OUTLINE:
              painter.drawRectF(i * cellWidthPx + outlinePenWidthPx,
                y + outlinePenWidthPx, 2, cellHeightPx - outlinePenWidthPx);
              break;

            default:
              break;
          }
        }
      }
      y += cellHeightPx;
    }
  }

  #configCursorStyleToRendererCursorStyle(configCursorStyle: ConfigCursorStyle): CursorStyle {
    switch (configCursorStyle) {
      case "block":
        return CursorStyle.BLOCK;
      case "underscore":
        return CursorStyle.UNDERLINE;
      case "beam":
        return CursorStyle.BEAM;
    }
  }

  #renderPreexitString(painter: QPainter): void {
    if (this.#emulator == null || this.#preeditString == null || this.#preeditString === "") {
      return;
    }
    const dim = this.#emulator.getDimensions();
    const y = (dim.cursorY + this.#scrollback.length) * this.#fontMetrics.heightPx + (1/128);
    // About 1/128, see else where.

    const line = new LineImpl(dim.cols, this.#terminalVisualConfig.palette, 0);
    line.setString(dim.cursorX, this.#preeditString);
    line.setBgClutIndex(dim.cursorX, 15); // white
    line.setFgClutIndex(dim.cursorX, 0);  // black
    this.#renderSingleLine(painter, line, y, false);
  }

  // private _configCursorStyleToHollowRendererCursorStyle(configCursorStyle: ConfigCursorStyle): CursorStyle {
  //   switch (configCursorStyle) {
  //     case "block":
  //       return CursorStyle.BLOCK_OUTLINE;
  //     case "underscore":
  //       return CursorStyle.UNDERLINE_OUTLINE;
  //     case "beam":
  //       return CursorStyle.BEAM_OUTLINE;
  //   }
  // }

  #handleMouseButtonPress(event: QMouseEvent): void {
    const termEvent = this.#qMouseEventToTermApi(event);

    if (termEvent.ctrlKey) {
      // Hyperlink click
      const line = this.getLine(termEvent.row + this.#scrollback.length);
      if (termEvent.column < line.width) {
        const linkID = line.getLinkID(termEvent.column);
        if (linkID !== 0) {
          const pair = line.getLinkURLByID(linkID);
          if (pair != null) {
            this.#onHyperlinkClickedEventEmitter.fire(pair.url);
            return;
          }
        }
      }

    } else {
      if (this.#emulator != null && termEvent.row >= 0 && this.#emulator.mouseDown(termEvent)) {
        return;
      }
    }

    if (termEvent.leftButton) {
      const newCoord = { x: termEvent.nearestColumnEdge, y: termEvent.row + this.#scrollback.length };
      if (termEvent.shiftKey && this.#selectionStart != null && this.#selectionEnd != null) {
        // Selection extension
        if (terminalCoordLessThan(newCoord, this.#selectionStart)) {
          this.#selectionStart = newCoord;
        } else {
          this.#selectionEnd = newCoord;
        }
      } else {
        this.#selectionStart = newCoord;
        this.#selectionEnd = null;
        this.#selectionMode = termEvent.shiftKey ? SelectionMode.BLOCK : SelectionMode.NORMAL;
        this.#isWordSelection = false;
      }

      this.#onSelectionChangedEventEmitter.fire();

      this.#widget.update();
    }
  }

  #qMouseEventToTermApi(event: QMouseEvent): ExpandedMouseEventOptions {
    const pos = this.pixelPointToCell(event.x(), event.y());
    const columnEdgePos = this.#pixelToRowColumnEdge(event.x(), event.y());

    const termEvent: ExpandedMouseEventOptions = {
      row: pos.y - this.#scrollback.length,
      column: pos.x,
      nearestColumnEdge: columnEdgePos.x,
      leftButton: (event.buttons() & MouseButton.LeftButton) !== 0,
      middleButton: (event.buttons() & MouseButton.MiddleButton) !== 0,
      rightButton: (event.buttons() & MouseButton.RightButton) !== 0,
      shiftKey: (event.modifiers() & KeyboardModifier.ShiftModifier) !== 0,
      metaKey: (event.modifiers() & KeyboardModifier.MetaModifier) !== 0,
      ctrlKey: (event.modifiers() & KeyboardModifier.ControlModifier) !== 0,
    };
    return termEvent;
  }

  #pixelToRowColumnEdge(x: number, y: number): TerminalCoord {
    const dpr = this.#widget.devicePixelRatio();
    const gridY = Math.floor(y / (this.#fontMetrics.heightPx / dpr));
    const gridX = Math.round(x / (this.#fontMetrics.widthPx / dpr));
    return { x: gridX, y: gridY };
  }

  pixelPointToCell(x: number, y: number): TerminalCoord {
    const dpr = this.#widget.devicePixelRatio();
    const gridY = Math.floor(y / (this.#fontMetrics.heightPx / dpr));
    const gridX = Math.floor(x / (this.#fontMetrics.widthPx / dpr));
    return { x: gridX, y: gridY };
  }

  rowToPixel(rowNumber: number): number {
    const dpr = this.#widget.devicePixelRatio();
    return this.#fontMetrics.heightPx * rowNumber * dpr;
  }

  #handleMouseButtonRelease(event: QMouseEvent): void {
    const termEvent = this.#qMouseEventToTermApi(event);
    if ( ! termEvent.ctrlKey && this.#emulator != null && termEvent.row >= 0 && this.#emulator.mouseUp(termEvent)) {
      return;
    }

    this.#onSelectionChangedEventEmitter.fire();
  }

  #handleMouseDoubleClick(event: QMouseEvent): void {
    const termEvent = this.#qMouseEventToTermApi(event);
    if ( ! termEvent.ctrlKey && this.#emulator != null && termEvent.row >= 0 && this.#emulator.mouseUp(termEvent)) {
      return;
    }
    this.#isWordSelection = true;

    this.#selectionStart = { x: this.#extendXWordLeft(termEvent), y: termEvent.row + this.#scrollback.length };
    this.#selectionEnd = { x: this.#extendXWordRight(termEvent), y: termEvent.row + this.#scrollback.length };
    this.#selectionMode = SelectionMode.NORMAL;

    this.#widget.update();
  }

  #extendXWordRight(termEvent: MouseEventOptions): number {
    const line = this.getLine(termEvent.row + this.#scrollback.length);
    const lineStringRight = line.getString(termEvent.column);
    const rightMatch = lineStringRight.match(WORD_SELECTION_REGEX);
    if (rightMatch != null) {
      return termEvent.column + countCells("" + rightMatch);
    }
    return termEvent.column;
  }

  #extendXWordLeft(termEvent: MouseEventOptions): number {
    const line = this.getLine(termEvent.row + this.#scrollback.length);
    const lineStringLeft = reverseString(line.getString(0, termEvent.column));
    const leftMatch = lineStringLeft.match(WORD_SELECTION_REGEX);
    if (leftMatch != null) {
      const newX = termEvent.column - countCells("" + leftMatch);
      return newX;
    }
    return termEvent.column;
  }

  #handleMouseMove(event: QMouseEvent): void {
    const termEvent = this.#qMouseEventToTermApi(event);
    // Try to feed the event to the emulator
    if ( ! termEvent.ctrlKey && this.#emulator != null && termEvent.row >= 0 && this.#emulator.mouseMove(termEvent)) {
      return;
    }

    if (termEvent.leftButton) {
      this.#handleSelectionMouseMove(termEvent);
      return;
    }
    this.#handleLinkMouseMove(termEvent);
  }

  #handleLinkMouseMove(termEvent: ExpandedMouseEventOptions): void {
    const previousURL = this.#hoveredURL;
    const previousGroup = this.#hoveredGroup;

    const line = this.getLine(termEvent.row + this.#scrollback.length);
    let linkID = 0;
    if (termEvent.column < line.width) {
      linkID = line.getLinkID(termEvent.column);
    }

    if (linkID === 0) {
      this.#hoveredURL = null;
      this.#hoveredGroup = null;
    } else {
      const { url, group } = line.getLinkURLByID(linkID);
      this.#hoveredURL = url;
      this.#hoveredGroup = group;
    }
    if (previousURL !== this.#hoveredURL || previousGroup !== this.#hoveredGroup) {
      this.#widget.update();
      this.#onHyperlinkHoverEventEmitter.fire(this.#hoveredURL);
    }
  }

  #handleSelectionMouseMove(termEvent: ExpandedMouseEventOptions): void {
    const eventColumn = termEvent.column;
    const emulatorRows = this.#emulator != null ? this.#emulator.getDimensions().materializedRows : 0;
    const eventRow = Math.min(termEvent.row, emulatorRows -1);

    if (this.#selectionStart == null) {
      this.#selectionStart = { x: eventColumn, y: eventRow + this.#scrollback.length };
      this.#selectionEnd = this.#selectionStart;
    }

    if (eventColumn === this.#selectionStart.x && eventRow === this.#selectionStart.y) {
      return;
    }

    let newSelectionEnd: TerminalCoord = null;
    if (this.#isWordSelection) {
      const isBeforeSelection = terminalCoordLessThan({x: eventColumn, y: eventRow + this.#scrollback.length},
                                                  this.#selectionStart);
      if (isBeforeSelection) {
        newSelectionEnd = { x: this.#extendXWordLeft(termEvent), y: eventRow + this.#scrollback.length };
      } else {
        newSelectionEnd = { x: this.#extendXWordRight(termEvent), y: eventRow + this.#scrollback.length };
      }
    } else {
      newSelectionEnd = { x: termEvent.nearestColumnEdge, y: eventRow + this.#scrollback.length };
    }
    if ( ! terminalCoordEqual(this.#selectionStart, newSelectionEnd)) {
      this.#selectionEnd = newSelectionEnd;
    }
    this.#widget.update();
  }

  getSelectionText(): string {
    if (this.#selectionMode === SelectionMode.NORMAL) {
      return this.getTextRange(this.#selectionStart, this.#selectionEnd);
    } else {
      return this.getTextBlock(this.#selectionStart, this.#selectionEnd);
    }
  }

  getTextRange(start: TerminalCoord, end: TerminalCoord): string {
    if (start == null || end == null) {
      return null;
    }

    if ((end.y < start.y) || (end.y === start.y && end.x < start.x)) {
      const tmp = end;
      end = start;
      start = tmp;
    }

    const firstRow = Math.max(start.y, 0);
    const lastRow = end.y + 1;

    const lineText: string[] = [];

    let isLastLineWrapped = false;

    for (let i=firstRow; i<lastRow; i++) {
      const line = this.getLine(i);
      if (i === start.y) {
        if (start.y === end.y) {
          // Small selection contained within one row.
          lineText.push(line.getString(start.x, end.x - start.x).trim());
        } else {
          // Top row of the selection.
          lineText.push(line.getString(start.x, line.width-start.x).trim());
        }
      } else {
        if ( ! isLastLineWrapped) {
          lineText.push("\n");
        }
        if (i !== end.y) {
          lineText.push(line.getString(0, line.width).trim());
        } else {
          // The last row of a multi-row selection.
          lineText.push(line.getString(0, end.x));
        }
      }
      isLastLineWrapped = line.isWrapped;
    }
    return lineText.join("");
  }

  getTextBlock(start: TerminalCoord, end: TerminalCoord): string {
    if (start == null || end == null) {
      return null;
    }

    if ((end.y < start.y) || (end.y === start.y && end.x < start.x)) {
      const tmp = end;
      end = start;
      start = tmp;
    }

    const firstRow = Math.max(start.y, 0);
    const lastRow = end.y + 1;

    const lineText: string[] = [];

    const startX = start.x;
    const endX = end.x;

    for (let i=firstRow; i<lastRow; i++) {
      const line = this.getLine(i);
      lineText.push(line.getString(startX, Math.min(endX - startX, line.width)).trim());
    }
    return lineText.join("\n");
  }

  getLine(row: number): Line {
    if (row < 0) {
      return null;
    }
    if (row < this.#scrollback.length) {
      return this.#scrollback[row];
    }
    const screenRow = row - this.#scrollback.length;
    if (this.#emulator == null) {
      return null;
    }
    const dimensions = this.#emulator.getDimensions();
    if (screenRow >= dimensions.rows) {
      return null;
    }
    return this.#emulator.lineAtRow(screenRow);
  }

  getCommandLine(): string {
    return this.#commandLine;
  }

  setCommandLine(commandLine: string): void {
    this.#commandLine = commandLine;
    this.#metadataChangedEventEmitter.fire();
  }

  getReturnCode(): number | null{
    return this.#returnCode;
  }

  setReturnCode(returnCode: number): void {
    this.#returnCode = returnCode;
    this.#metadataChangedEventEmitter.fire();
  }

  getMetadata(): BlockMetadata {
    const title = this.#commandLine !== null ? this.#commandLine : "Terminal Command";
    const icon = this.#returnCode === 0 ? "fa-check" : "fa-times";

    let posture = BlockPosture.RUNNING;
    switch(this.#returnCode) {
      case null:
        posture = BlockPosture.RUNNING;
        break;
      case 0:
        posture = BlockPosture.SUCCESS;
        break;
      default:
        posture = BlockPosture.FAILURE;
        break;
    }

    let toolTip: string = null;
    if (this.#returnCode != null) {
      toolTip = `Return code: ${this.#returnCode}`;
    }

    return {
      title,
      icon,
      posture,
      moveable: false,
      deleteable: false
    };
  }

  deleteTopLines(lineCount: number): void {
    this.#scrollback.splice(0, lineCount);

    let selectionStart = this.#selectionStart;
    let selectionEnd = this.#selectionEnd;
    if (selectionStart != null && selectionEnd != null) {
      // Correctly order the selection start and end points;
      if ((selectionEnd.y < selectionStart.y) || (selectionEnd.y === selectionStart.y && selectionEnd.x < selectionStart.x)) {
        selectionStart = this.#selectionEnd;
        selectionEnd = this.#selectionStart;
      }

      if (selectionEnd.y <= lineCount) {
        this.#selectionStart = null;
        this.#selectionEnd = null;
      } else {
        if (selectionStart.y <= lineCount) {
          this.#selectionStart = { x: 0, y: 0 };
        }
        this.#selectionEnd = selectionEnd;
      }
    }

    this.#updateWidgetSize();
    this.#widget.update();
  }

  getBulkFile(): BulkFile {
    return new BlobBulkFile("text/plain;charset=utf8", {}, Buffer.from(this.#getText(), "utf8"));
  }

  #getText(): string {
    const lines: string[] = [];
    const len = this.#scrollback.length;
    for (let y=0; y<len; y++) {
      const line = this.#scrollback[y];
      lines.push(line.getString(0));
      if ( ! line.isWrapped) {
        lines.push("\n");
      }
    }
    return lines.join("");
  }
}


function terminalCoordEqual(a: TerminalCoord, b: TerminalCoord): boolean {
  return a.x === b.x && a.y === b.y;
}

function terminalCoordLessThan(a: TerminalCoord, b: TerminalCoord): boolean {
  if (a.y < b.y) {
    return true;
  }
  if (a.y === b.y) {
    return a.x < b.x;
  }
  return false;
}
