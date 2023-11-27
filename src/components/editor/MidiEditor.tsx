import React, { createRef, useContext, useEffect, useRef, useState } from "react";
import { produce } from "immer"
import { startFreq, stopFreq } from "@synth/engineOLD";
import '@styles/editor/MidiEditor.css';
import { onKeyPressed, onKeyUp, pressedFrequencies, clickedFreq } from "@synth/keylistener"
import NumberUpDown from "@components/editor/NumberUpDown";
import Key from "@components/synthesizer/Key";
import ProjectContext from "@src/context/projectcontext";
import Note from "@models/note";
import { generateId } from "@network/crypto";
import { broadcast, handle } from "@network/sessions";
import NetworkContext from "@src/context/networkcontext";
import { zoomBase } from "@models/project";
import { slipFloor } from "@src/scripts/math";
import Timeline from "./Timeline";
import ZoomContext from "@src/context/zoomcontext";
import PositionContext from "@src/context/positioncontext";
import PositionContainer from "./PositionContainer";
import ModalContainer from "@components/modal/ModalContainer";

export default function MidiEditor(props: { patternId: string }) {
    const { project, setProject } = useContext(ProjectContext);
    const { socket, cryptoKey } = useContext(NetworkContext);

    const [snap, setSnap] = useState(project.data.patterns[props.patternId].snap ?? 4);
    const [tact, setTact] = useState(project.data.patterns[props.patternId].tact ?? 4);

    const mode = useRef<{ x: 'move' | 'resize_right' | 'resize_left' | undefined, y: 'move' | undefined }>()

    const contentRef = createRef<HTMLDivElement>();
    const editorRef = createRef<HTMLDivElement>();

    //Freq = note x 2^(N/12)
    const noteList = Array.from(genLookupTable()).sort(([, v1], [, v2]) => v2 - v1);

    const [zoom, setZoom] = useState(project.data.patterns[props.patternId].zoom ?? 1);
    const _zoom = useRef(zoom);

    const [position, setPosition] = useState(project.data.patterns[props.patternId].position ?? 1);
    const _position = useRef(position);

    const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
    const [mouseMoveRelative, setMouseMoveRelative] = useState({ x: 0, y: 0 });
    const _mouseDownOrigin = useRef({ x: 0, y: 0 });
    const [selectionStart, setSelectionStart] = useState({ x: 0, y: 0 });
    const [selectionEnd, setSelectionEnd] = useState({ x: 0, y: 0 });
    const _selectionOrigin = useRef<{ x: number, y: number }>();

    const [mousePositions, setMousePositions] = useState<{ [id: string]: { x: number, y: number } }>({});
    const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

    function correctNoteErrors() {
        setProject(produce(draft => {
            Object.keys(draft.data.patterns[props.patternId].notes).forEach(id => {
                const note = draft.data.patterns[props.patternId].notes[id];
                if (!note) return;

                if (note.length < 0) {
                    note.start += note.length;
                    note.length *= -1;
                }

                if (note.start < 0) {
                    note.length += note.start;
                    note.start = 0;
                }
            });
        }))
    }

    function handleSnapNotes(_ev: React.MouseEvent) {
        function run(note: Note) {
            note.start = slipFloor(note.start, 1 / snap);
            note.length = slipFloor(note.length, 1 / snap);
        }

        setProject(produce(draft => {
            const notes = draft.data.patterns[props.patternId].notes;
            if (selectedNotes.size == 0) {
                Object.keys(draft.data.patterns[props.patternId].notes).forEach(id => run(notes[id]));
            }
            else {
                selectedNotes.forEach(id => run(notes[id]));
            }
        }));

        setMouseMoveRelative({ x: 0, y: 0 });
    }

    function handleEditorWheel(ev: WheelEvent) {
        if (ev.ctrlKey) {
            ev.preventDefault();

            let oldSize = zoomBase * Math.E ** _zoom.current;
            let value = _zoom.current - ev.deltaY / 300;
            _zoom.current = Math.max(Math.min(value, 2), -1);
            let newSize = zoomBase * Math.E ** _zoom.current;
            setZoom(_zoom.current);

            let counterWeight = ev.offsetX - ev.offsetX * newSize / oldSize;
            _position.current = Math.max(_position.current / oldSize * newSize - counterWeight, 0);
            setPosition(_position.current);
        }

        else if (ev.shiftKey) {
            ev.preventDefault();
            let value = _position.current + ev.deltaX + ev.deltaY;
            _position.current = Math.max(value, 0);
            setPosition(_position.current);
        }

        else if (Math.abs(ev.deltaX) > 0) {
            ev.preventDefault();
            let value = _position.current + ev.deltaX;
            _position.current = Math.max(value, 0);
            setPosition(_position.current);
        }
    }

    function handleEditorMouseDown(ev: React.MouseEvent) {
        if (ev.nativeEvent.which == 3) {
            setSelectedNotes(new Set());
            return;
        };
        let rect = editorRef.current!.getBoundingClientRect();
        let x = ev.clientX - rect.left;
        let y = ev.clientY - rect.top;
        let start = slipFloor((x + _position.current) / (zoomBase * Math.E ** _zoom.current / tact), 1 / snap);
        let pitch = Math.floor(y / 36);

        if (ev.buttons == 1 && ev.shiftKey) {
            _selectionOrigin.current = { x: x, y: y };
            setSelectionStart({ x: x, y: y });
            setSelectionEnd({ x: x, y: y });
            return;
        }

        const id = generateId(new Set(Object.keys(project.data.patterns[props.patternId].notes)));
        const note = {
            start: start,
            pitch: pitch,
            length: 1 / snap
        };

        setProject(produce(draft => {
            draft.data.patterns[props.patternId].notes[id] = note
        }))

        if (socket) {
            broadcast(socket, cryptoKey!, 'hh:note-created', {
                patternId: props.patternId,
                id: id,
                note: note
            });
        }

        _mouseDownOrigin.current = { x: start, y: pitch };
        setSelectedNotes(new Set([id]));
        mode.current = { x: 'resize_right', y: 'move' };
    }

    function handleEditorMouseUp(_ev: React.MouseEvent) {
        mode.current = undefined;
        _selectionOrigin.current = undefined;
        setSelectionStart({ x: 0, y: 0 });
        setSelectionEnd({ x: 0, y: 0 });
        correctNoteErrors();
    }

    function handleEditorMouseMove(ev: React.MouseEvent) {
        if (_selectionOrigin.current && ev.buttons == 1 && ev.shiftKey) {
            let rect = editorRef.current!.getBoundingClientRect();
            let x = ev.clientX - rect.left;
            let y = ev.clientY - rect.top;
            setSelectionStart({
                x: Math.min(x, _selectionOrigin.current.x),
                y: Math.min(y, _selectionOrigin.current.y)
            });
            setSelectionEnd({
                x: Math.max(x, _selectionOrigin.current.x),
                y: Math.max(y, _selectionOrigin.current.y)
            });

            let startX = (selectionStart.x + _position.current) / (zoomBase * Math.E ** _zoom.current / tact);
            let startY = selectionStart.y / 36;
            let endX = (selectionEnd.x + _position.current) / (zoomBase * Math.E ** _zoom.current / tact);
            let endY = selectionEnd.y / 36;

            Object.keys(project.data.patterns[props.patternId].notes).forEach(id => {
                const note = project.data.patterns[props.patternId].notes[id];
                if ((
                    note.start + note.length > startX && note.start <= endX ||
                    note.start >= endX && note.start <= startX) && (
                        note.pitch + 1 >= startY && note.pitch <= endY ||
                        note.pitch <= startY && note.pitch >= endY)
                ) {
                    selectedNotes.add(id);
                } else {
                    selectedNotes.delete(id);
                }
            });

            return;
        }

        let rect = editorRef.current!.getBoundingClientRect();
        let x = ev.clientX - rect.left;
        let y = ev.clientY - rect.top;
        let start = slipFloor((x + _position.current) / (zoomBase * Math.E ** _zoom.current / tact), 1 / snap);
        let pitch = Math.floor(y / 36);
        if (start != _mouseDownOrigin.current.x || pitch != _mouseDownOrigin.current.y) {
            setMouseMoveRelative({ x: start - _mouseDownOrigin.current.x, y: pitch - _mouseDownOrigin.current.y });
            _mouseDownOrigin.current = { x: start, y: pitch };
        }

        setMousePosition({ x, y })
    }

    useEffect(() => {
        if (socket) {
            handle(socket, cryptoKey!, 'hh:mouse-position-pattern', (id, { x, y, patternId }) => {
                if (patternId != props.patternId) return;

                setMousePositions({
                    ...mousePositions,
                    [id]: { x, y }
                });
            })

            // todo cleanup function
        }
    }, [socket])

    useEffect(() => {
        if (!mode.current) return;

        setProject(produce(draft => {
            selectedNotes.forEach(selectedNote => {
                const note = draft.data.patterns[props.patternId].notes[selectedNote];
                if (!note) return;

                if (mode.current?.x == 'resize_left') {
                    note.start += mouseMoveRelative.x;
                    if (note.start < 0) {
                        note.length += note.start;
                        note.start = 0;
                    }
                    note.length -= mouseMoveRelative.x;
                }

                if (mode.current?.x == 'resize_right') {
                    note.length += mouseMoveRelative.x;
                    if (note.start + note.length < 0) {
                        note.length = -note.start;
                    }
                }

                if (mode.current?.x == 'move') {
                    note.start += mouseMoveRelative.x;
                    if (note.start < 0) {
                        note.length += note.start;
                        note.start = 0;
                    }
                }

                if (mode.current?.y == 'move') {
                    note.pitch += mouseMoveRelative.y;
                }
            });
        }));
    }, [mouseMoveRelative])

    function handleNoteMouseDown(ev: React.MouseEvent) {
        if (ev.nativeEvent.which == 3) {
            handleNoteMouseMove(ev);
            return;
        };
        ev.stopPropagation();
        let rect = editorRef.current!.getBoundingClientRect();
        let x = ev.clientX - rect.left;
        let y = ev.clientY - rect.top;
        let start = slipFloor((x + _position.current) / (zoomBase * Math.E ** _zoom.current / tact), 1 / snap);
        let pitch = Math.floor(y / 36);

        const id = ev.currentTarget.getAttribute("data-id")!

        if (ev.shiftKey) {
            if (selectedNotes.has(id)) {
                selectedNotes.delete(id);
                setSelectedNotes(new Set(selectedNotes));
            }
            else {
                selectedNotes.add(id);
                setSelectedNotes(new Set(selectedNotes));
            }
            return;
        }

        mode.current = { x: 'move', y: 'move' }
        _mouseDownOrigin.current = { x: start, y: pitch };
        if (selectedNotes.has(id)) {
            setSelectedNotes(new Set([...selectedNotes, id]));
        } else {
            setSelectedNotes(new Set([id]));
        }
    }

    function handleNoteMouseMove(ev: React.MouseEvent) {
        if (ev.nativeEvent.which != 3) return;
        ev.stopPropagation();

        setProject(produce(draft => {
            if (ev.currentTarget === null) return; // idk why this is needed, but it is
            const id = ev.currentTarget.getAttribute("data-id")!;
            delete draft.data.patterns[props.patternId].notes[id];
            selectedNotes.delete(id);
        }));
    }

    function handleResizeRightMouseDown(_ev: React.MouseEvent) {
        // bubble up the event to the note, but set the mode to resize_right
        setTimeout(() => {
            mode.current = { x: 'resize_right', y: undefined }
        })
    }

    function handleResizeLeftMouseDown(_ev: React.MouseEvent) {
        // bubble up the event to the note, but set the mode to resize_left
        setTimeout(() => {
            mode.current = { x: 'resize_left', y: undefined }
        })
    }

    function genNoteName(idx: number) {
        let arr = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        return arr[idx % arr.length];
    }

    function genLookupTable() {
        let map = new Map<string, number>()
        const root = { name: "C0", freq: 16.35 };
        for (let index = 0; index < 12 * 8; index++) {
            let value: number = root.freq;
            value = root.freq * ((2 ** (1 / 12)) ** index);

            let key: string = Math.floor(index / 12) + "-" + genNoteName(index)
            map.set(key, value);
        }

        return map;
    }

    const [mouseDown, setMouseDown] = useState(false);
    const _mouseDown = useRef(mouseDown);

    function onMouseDown() {
        _mouseDown.current = true;
        setMouseDown(true);
    }
    function onMouseUp() {
        _mouseDown.current = false;
        setMouseDown(false);
    }

    useEffect(() => {
        contentRef.current!.scrollTop = contentRef.current!.children[0].clientHeight / 2 - contentRef.current!.clientHeight * 0.8;
        editorRef.current?.addEventListener('wheel', handleEditorWheel);
        return () => {
            editorRef.current?.removeEventListener('wheel', handleEditorWheel);
        }
    }, [])

    useEffect(() => {
        setProject(produce(draft => {
            let pattern = draft.data.patterns[props.patternId]
            pattern.zoom = zoom;
            pattern.position = position;
            pattern.snap = snap;
            pattern.tact = tact;
        }));
    }, [zoom, position, snap, tact])

    useEffect(() => {
        socket && broadcast(socket, cryptoKey!, 'hh:mouse-position-pattern', {
            x: (mousePosition.x + _position.current) / (zoomBase * Math.E ** _zoom.current / tact),
            y: mousePosition.y,
            patternId: props.patternId
        });
    }, [zoom, position, mousePosition])

    useEffect(() => {
        document.addEventListener("mousedown", onMouseDown);
        document.addEventListener("mouseup", onMouseUp);
        document.addEventListener("keydown", onKeyPressed);
        document.addEventListener("keyup", onKeyUp);
        return () => {
            document.removeEventListener("mousedown", onMouseDown);
            document.removeEventListener("mouseup", onMouseUp);
            document.removeEventListener("keydown", onKeyPressed);
            document.removeEventListener("keyup", onKeyUp);
        }
    }, []);

    function onNoteStart(e: React.MouseEvent, freq: number, key: string) {
        e.preventDefault();

        if (_mouseDown.current) {
            clickedFreq.value = freq;
            // console.warn(clickedFreq.value);
            if (!pressedFrequencies.includes(freq)) {
                startFreq(freq);
                if (key.includes('#')) {
                    e.currentTarget.classList.add("pressed-black");
                }
                else {
                    e.currentTarget.classList.add("pressed-white");
                }
            }
        }
    }

    function onNoteStop(e: React.MouseEvent, freq: number, key: string) {
        e.preventDefault();
        if (!pressedFrequencies.includes(freq)) {
            if (key.includes('#')) {
                e.currentTarget.classList.remove("pressed-black");
            }
            else {
                e.currentTarget.classList.remove("pressed-white");
            }
            stopFreq(freq);
        }
        clickedFreq.value = null;
        // console.warn(clickedFreq.value);
    }

    return (
        <ZoomContext.Provider value={{
            zoom, factor: zoomBase * Math.E ** zoom
        }}>
            <PositionContext.Provider value={{
                position
            }}>
                <ModalContainer mode="fill" className="piano-roll overlay-fill">
                    <div className="toolbar">
                        <span>Notes / Beat: </span>
                        <NumberUpDown
                            value={tact}
                            onChange={(value) => setTact(value)}
                            min={1}
                            max={16}
                            step={1} />
                        <span>Snapping: </span>
                        <NumberUpDown
                            value={snap}
                            onChange={(value) => setSnap(value)}
                            min={1}
                            max={8}
                            step={1} />
                        <button onClick={handleSnapNotes}>Snap notes to rythm</button>
                    </div>

                    <Timeline offset={170} />

                    <div className="content" ref={contentRef}>
                        <ul className="octaves">
                            {noteList.map(([key, value]) => key.split("-")[1] == 'C' && <li key={key + value + "octave"} className={"octave " + (key.split("-")[0] == '4' ? "base-octave" : "")}>
                                {key.split("-")[0]}
                            </li>
                            )}
                        </ul>
                        <ul className="keys">
                            {noteList.map(([key, value]) =>
                                <li key={key + value + "key"}>
                                    <Key
                                        onMouseEnter={(e: React.MouseEvent) => onNoteStart(e, value, key)}
                                        onMouseLeave={(e: React.MouseEvent) => onNoteStop(e, value, key)}
                                        onMouseDown={(e: React.MouseEvent) => {
                                            clickedFreq.value = value;
                                            if (!pressedFrequencies.includes(value)) {
                                                startFreq(value);
                                                e.currentTarget.classList.add(key.includes('#') ? "pressed-black" : "pressed-white");
                                            }
                                        }}
                                        keyName={key.split("-")[1]}
                                        frequency={value} />
                                </li>
                            )}
                        </ul>

                        <section
                            className="midi-editor"
                            ref={editorRef}
                            style={{
                                backgroundSize: `${zoomBase * Math.E ** zoom}px 72px`,
                                backgroundPositionX: -position,
                                backgroundImage: ` \
                                    linear-gradient(0deg,#00000000 50%,#00000044 50%), \
                                    linear-gradient(90deg,#6e6e6e 0px,#6e6e6e 4px,#00000000 4px), \
                                    linear-gradient(90deg, ${(function () {
                                        let result = [];
                                        for (let i = 0; i < tact; i++) {
                                            let percent = 100 / tact * i;
                                            result.push(`#00000000 ${percent}%,#a0a0a0 ${percent}%,#a0a0a0 ${percent + 1}%,#00000000 ${percent + 1}%`)
                                        }
                                        return result.join(',');
                                    })()})`
                            }}
                            onMouseDown={handleEditorMouseDown}
                            onMouseMove={handleEditorMouseMove}
                            onMouseUp={handleEditorMouseUp}
                            onContextMenu={ev => ev.preventDefault()}>
                            {selectionStart.x != selectionEnd.x && selectionStart.y != selectionEnd.y && <div className="selection" style={{
                                width: `${Math.abs(selectionStart.x - selectionEnd.x)}px`,
                                height: `${Math.abs(selectionStart.y - selectionEnd.y)}px`,
                                left: `${Math.min(selectionStart.x, selectionEnd.x)}px`,
                                top: `${Math.min(selectionStart.y, selectionEnd.y)}px`,
                            }} />}
                            <PositionContainer>
                                {Object.keys(project.data.patterns[props.patternId].notes).map(id => {
                                    const note = project.data.patterns[props.patternId].notes[id];
                                    const factor = zoomBase * Math.E ** zoom / tact;
                                    return (
                                        <li key={`note-[${id}]`} data-id={id}
                                            className={["note", selectedNotes.has(id) ? "selected" : ""].join(" ")}
                                            onMouseDown={handleNoteMouseDown}
                                            onMouseMove={handleNoteMouseMove}
                                            style={{
                                                width: `${Math.abs(note.length) < Number.EPSILON
                                                    ? factor * 0.2
                                                    : factor * Math.abs(note.length)}px`,
                                                left: `${Math.abs(note.length) < Number.EPSILON
                                                    ? factor * note.start - factor * 0.2 / 2
                                                    : note.length < 0
                                                        ? factor * (note.start + note.length)
                                                        : factor * note.start}px`,
                                                top: `${note.pitch * 36}px`,
                                            }}>
                                            <div onMouseDown={handleResizeLeftMouseDown} />
                                            <div style={{ fontSize: '0.8em' }}>{/*`${note.start.toPrecision(3)}, ${note.length.toPrecision(3)}`*/}</div>
                                            <div onMouseDown={handleResizeRightMouseDown} />
                                        </li>
                                    )
                                })}
                            </PositionContainer>
                            <section className="mouse-cursors" style={{ left: -position }}>
                                {Object.keys(mousePositions).map(id => {
                                    const pos = mousePositions[id];
                                    const factor = zoomBase * Math.E ** zoom / tact;
                                    return <div key={id} className="cursor" style={{ left: pos.x * factor, top: pos.y }}>
                                        <span className="cursor-name">{id}</span>
                                    </div>
                                })}
                            </section>
                        </section>
                    </div>
                </ModalContainer>
            </PositionContext.Provider>
        </ZoomContext.Provider>
    )
}
