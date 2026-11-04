import "./styles.css";

import { Button as BaseButton } from "@components/Button";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import {
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalProps,
    ModalRoot,
    ModalSize,
    openModal,
} from "@utils/modal";
import definePlugin from "@utils/types";
import {
    ChannelStore,
    Menu,
    RestAPI,
    UserStore,
    useEffect,
    useState,
} from "@webpack/common";

/* ============================================================
 * BOTÃO (wrapper para a API nova do Vencord)
 * ============================================================
 */

const ButtonColors = {
    PRIMARY: "primary",
    TRANSPARENT: "secondary",
    RED: "dangerPrimary",
} as const;

type ButtonColor = (typeof ButtonColors)[keyof typeof ButtonColors];

function Button({
    color = "primary",
    ...props
}: {
    color?: ButtonColor;
    onClick?: () => void;
    disabled?: boolean;
    children?: React.ReactNode;
}) {
    return <BaseButton variant={color} {...props} />;
}

Button.Colors = ButtonColors;

/* ============================================================
 * TIPOS
 * ============================================================
 */

type FilterMode = "all" | "attachments" | "images";
type PurgeAction = "delete" | "edit";
type RangeMode = "all" | "date" | "message";

/**
 * Tipos de mensagem que o Discord permite editar:
 * 0 = normal, 19 = resposta.
 */
const EDITABLE_TYPES = [0, 19];

interface DiscordAttachment {
    id: string;
    filename?: string;
    content_type?: string;
}

interface DiscordMessage {
    id: string;
    channel_id: string;
    type?: number;
    hit?: boolean;
    author?: {
        id: string;
    };
    content?: string;
    attachments?: DiscordAttachment[];
}

interface PurgeOptions {
    channelId: string;
    guildId: string | null;
    isGuildScan: boolean;
    targetMessage: DiscordMessage;
    includeTarget: boolean;
    maxMessages: number;
    filterMode: FilterMode;
    action: PurgeAction;
    editText: string;
    /** Menor ID (mais antigo) permitido, inclusive. null = sem limite. */
    minId: bigint | null;
    /** Maior ID (mais novo) permitido, inclusive. null = sem limite. */
    maxId: bigint | null;
}

interface PurgeState {
    running: boolean;
    paused: boolean;
    cancelled: boolean;

    phase: "idle" | "scanning" | "processing" | "finished";
    action: PurgeAction;
    isGuild: boolean;
    ranged: boolean;

    scanned: number;
    totalMessages: number;

    ownMessages: number;
    eligibleMessages: number;

    found: number;
    deleted: number;
    failed: number;

    status: string;
    startedAt: number;
}

function createInitialState(status: string, startedAt: number): PurgeState {
    return {
        running: false,
        paused: false,
        cancelled: false,

        phase: "idle",
        action: "delete",
        isGuild: false,
        ranged: false,

        scanned: 0,
        totalMessages: 0,

        ownMessages: 0,
        eligibleMessages: 0,

        found: 0,
        deleted: 0,
        failed: 0,

        status,
        startedAt,
    };
}

let state: PurgeState = createInitialState("Parado", 0);

let updateModal: (() => void) | undefined;

let toolbarButton: HTMLButtonElement | undefined;
let toolbarObserver: MutationObserver | undefined;

const TOOLBAR_BUTTON_ID = "message-purger-toolbar-button";

/* ============================================================
 * INTERVALO (datas e mensagem final)
 * ============================================================
 */

const DISCORD_EPOCH = 1420070400000;

function dateToSnowflake(ms: number): bigint {
    return BigInt(Math.max(0, ms - DISCORD_EPOCH)) << 22n;
}

function snowflakeToDate(id: string): Date {
    return new Date(Number(BigInt(id) >> 22n) + DISCORD_EPOCH);
}

interface EndMarker {
    id: string;
    channelId: string;
    preview: string;
}

/** Mensagem marcada pelo usuário como limite final (a mais antiga). */
let endMarker: EndMarker | undefined;

function isInRange(id: string, options: PurgeOptions): boolean {
    const value = BigInt(id);

    return (
        (options.minId === null || value >= options.minId) &&
        (options.maxId === null || value <= options.maxId)
    );
}

/**
 * Ponto de partida da varredura (exclusivo): a mensagem selecionada,
 * ou o fim do período, o que for mais antigo.
 */
function getUpperBound(options: PurgeOptions): bigint {
    let upper = BigInt(options.targetMessage.id);

    if (options.maxId !== null && options.maxId + 1n < upper) {
        upper = options.maxId + 1n;
    }

    return upper;
}

function notifyUI() {
    updateModal?.();
    updateToolbarButton();
}

function sleep(ms: number) {
    return new Promise<void>(resolve => {
        setTimeout(resolve, ms);
    });
}

async function waitIfPaused() {
    while (state.paused && !state.cancelled) {
        await sleep(250);
    }
}

function resetState() {
    state = createInitialState("Preparando...", Date.now());
    notifyUI();
}

/* ============================================================
 * TEXTOS POR AÇÃO
 * ============================================================
 */

function doneLabel(action: PurgeAction) {
    return action === "edit" ? "Editadas" : "Apagadas";
}

function doingLabel(action: PurgeAction) {
    return action === "edit" ? "Editando" : "Apagando";
}

function phaseName(action: PurgeAction) {
    return action === "edit" ? "EDIÇÃO" : "EXCLUSÃO";
}

/* ============================================================
 * FILTROS
 * ============================================================
 */

function isImageAttachment(attachment: DiscordAttachment): boolean {
    if (
        attachment.content_type &&
        attachment.content_type.toLowerCase().startsWith("image/")
    ) {
        return true;
    }

    if (!attachment.filename) {
        return false;
    }

    return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(
        attachment.filename,
    );
}

function messageMatchesFilter(
    message: DiscordMessage,
    filterMode: FilterMode,
): boolean {
    const attachments = message.attachments ?? [];

    switch (filterMode) {
        case "attachments":
            return attachments.length > 0;

        case "images":
            return attachments.some(isImageAttachment);

        case "all":
        default:
            return true;
    }
}

function getFilterName(filterMode: FilterMode): string {
    switch (filterMode) {
        case "attachments":
            return "Com anexos";

        case "images":
            return "Somente imagens";

        case "all":
        default:
            return "Todas";
    }
}

/**
 * Decide se uma mensagem entra na lista de alvos.
 */
function shouldProcess(
    message: DiscordMessage,
    options: PurgeOptions,
    myUserId: string,
): boolean {
    if (message.author?.id !== myUserId) {
        return false;
    }

    if (!messageMatchesFilter(message, options.filterMode)) {
        return false;
    }

    if (options.action === "edit") {
        if (
            message.type !== undefined &&
            !EDITABLE_TYPES.includes(message.type)
        ) {
            return false;
        }

        // Já está com o texto novo, não precisa editar.
        if ((message.content ?? "") === options.editText) {
            return false;
        }
    }

    return true;
}

/* ============================================================
 * REQUISIÇÕES
 * ============================================================
 */

function getRetryDelay(error: any, attempt: number): number {
    const retryAfter =
        Number(error?.body?.retry_after) ||
        Number(error?.retry_after) ||
        0;

    return retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : Math.min(1500 * 2 ** attempt, 10_000);
}

/**
 * Erros 4xx (exceto 429) não adiantam tentar de novo:
 * mensagem inexistente, sem permissão etc.
 */
function isFatalError(error: any): boolean {
    const status = Number(error?.status);

    return status >= 400 && status < 500 && status !== 429;
}

async function applyAction(
    options: PurgeOptions,
    messageId: string,
): Promise<void> {
    const url = `/channels/${options.channelId}/messages/${messageId}`;

    if (options.action === "edit") {
        await RestAPI.patch({
            url,
            body: { content: options.editText },
        });

        return;
    }

    await RestAPI.del({ url });
}

async function applyWithRetry(
    options: PurgeOptions,
    messageId: string,
): Promise<boolean> {
    const maxRetries = 5;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (state.cancelled) {
            return false;
        }

        await waitIfPaused();

        if (state.cancelled) {
            return false;
        }

        try {
            await applyAction(options, messageId);

            return true;
        } catch (error: any) {
            if (state.cancelled || isFatalError(error)) {
                return false;
            }

            state.status =
                `Limite de requisições. Aguardando... ${attempt + 1}/${maxRetries}`;

            notifyUI();

            await sleep(getRetryDelay(error, attempt));
        }
    }

    return false;
}

/**
 * GET com tratamento de rate limit e de "índice de busca ainda
 * não disponível" (HTTP 202), que o Discord devolve na busca.
 */
async function getWithRetry(
    url: string,
    query: Record<string, string | number>,
): Promise<any | null> {
    const maxRetries = 8;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (state.cancelled) {
            return null;
        }

        await waitIfPaused();

        if (state.cancelled) {
            return null;
        }

        try {
            const response = await RestAPI.get({ url, query });

            if (response.status === 202) {
                state.status =
                    "Aguardando o Discord indexar o canal...";

                notifyUI();

                const wait =
                    Number(response.body?.retry_after) || 2;

                await sleep(Math.min(wait * 1000, 15_000));

                continue;
            }

            return response;
        } catch (error: any) {
            if (state.cancelled) {
                return null;
            }

            if (isFatalError(error)) {
                throw error;
            }

            state.status =
                `Limite de requisições. Aguardando... ${attempt + 1}/${maxRetries}`;

            notifyUI();

            await sleep(getRetryDelay(error, attempt));
        }
    }

    throw new Error("Falha ao buscar mensagens.");
}

/* ============================================================
 * PROGRESSO
 * ============================================================
 */

function getProgressPercentage(): number {
    if (state.phase === "scanning") {
        if (state.totalMessages <= 0) {
            return 0;
        }

        return Math.min(
            100,
            Math.round(
                (state.scanned / state.totalMessages) * 100,
            ),
        );
    }

    if (
        state.phase === "processing" ||
        state.phase === "finished"
    ) {
        const target = state.eligibleMessages;

        if (target <= 0) {
            return state.phase === "finished" ? 100 : 0;
        }

        return Math.min(
            100,
            Math.round((state.deleted / target) * 100),
        );
    }

    return 0;
}

/* ============================================================
 * VARREDURA
 * ============================================================
 */

/**
 * Registra uma mensagem encontrada nas estatísticas.
 * Em servidores só as mensagens do usuário chegam aqui, então
 * o "total da conversa" não é contado.
 */
function registerMessage(
    message: DiscordMessage,
    options: PurgeOptions,
    myUserId: string,
    out: string[],
) {
    state.scanned++;

    if (!options.isGuildScan) {
        state.totalMessages++;
    }

    if (message.author?.id === myUserId) {
        state.ownMessages++;

        if (shouldProcess(message, options, myUserId)) {
            state.eligibleMessages++;
            out.push(message.id);
        }
    }
}

/**
 * Chat privado / grupo: percorre o histórico inteiro e conta
 * as mensagens de todos os participantes.
 */
async function scanDirectMessages(
    options: PurgeOptions,
    myUserId: string,
    out: string[],
) {
    let beforeId = getUpperBound(options).toString();

    while (!state.cancelled) {
        await waitIfPaused();

        if (state.cancelled) {
            break;
        }

        state.status =
            `Varredura: ${state.scanned} mensagens verificadas...`;

        notifyUI();

        const response = await getWithRetry(
            `/channels/${options.channelId}/messages`,
            { limit: 100, before: beforeId },
        );

        if (!response) {
            break;
        }

        const messages =
            (response.body as DiscordMessage[] | undefined) ?? [];

        if (messages.length === 0) {
            break;
        }

        let reachedMin = false;

        for (const message of messages) {
            if (state.cancelled) {
                break;
            }

            // Passou do limite mais antigo: não precisa ir além.
            if (
                options.minId !== null &&
                BigInt(message.id) < options.minId
            ) {
                reachedMin = true;

                break;
            }

            registerMessage(message, options, myUserId, out);
        }

        notifyUI();

        if (reachedMin) {
            break;
        }

        const lastMessage = messages[messages.length - 1];

        if (!lastMessage?.id) {
            break;
        }

        beforeId = lastMessage.id;
    }
}

/**
 * Servidor: usa a busca do Discord filtrando pelo próprio autor,
 * então só as SUAS mensagens são consultadas (as dos outros
 * nunca são baixadas nem contadas).
 */
async function scanGuildMessages(
    options: PurgeOptions,
    myUserId: string,
    out: string[],
) {
    const upperBound = getUpperBound(options);
    const seen = new Set<string>();

    let maxId = upperBound.toString();
    let firstPage = true;

    while (!state.cancelled) {
        await waitIfPaused();

        if (state.cancelled) {
            break;
        }

        state.status =
            `Varredura: ${state.scanned} mensagens suas verificadas...`;

        notifyUI();

        const query: Record<string, string> = {
            author_id: myUserId,
            channel_id: options.channelId,
            max_id: maxId,
            sort_by: "timestamp",
            sort_order: "desc",
            include_nsfw: "true",
        };

        if (options.minId !== null) {
            query.min_id = (options.minId - 1n).toString();
        }

        const response = await getWithRetry(
            `/guilds/${options.guildId}/messages/search`,
            query,
        );

        if (!response) {
            break;
        }

        const body = response.body as
            | {
                total_results?: number;
                messages?: DiscordMessage[][];
            }
            | undefined;

        if (firstPage) {
            state.totalMessages = Number(body?.total_results) || 0;
            firstPage = false;
        }

        const messages = (body?.messages ?? [])
            .flat()
            .filter(message => message.author?.id === myUserId);

        if (messages.length === 0) {
            break;
        }

        const fresh = messages.filter(
            message =>
                !seen.has(message.id) &&
                BigInt(message.id) < upperBound &&
                (options.minId === null ||
                    BigInt(message.id) >= options.minId),
        );

        // Sem nada novo na página: terminou (ou a busca repetiu).
        if (fresh.length === 0) {
            break;
        }

        for (const message of fresh) {
            if (state.cancelled) {
                break;
            }

            seen.add(message.id);

            registerMessage(message, options, myUserId, out);
        }

        notifyUI();

        maxId = messages[messages.length - 1].id;

        // A busca tem rate limit mais apertado que a listagem normal.
        await sleep(1200);
    }

    // Garante que a barra não passe de 100% se o total mudou.
    if (state.totalMessages < state.scanned) {
        state.totalMessages = state.scanned;
    }
}

async function scanMessages(
    options: PurgeOptions,
    myUserId: string,
): Promise<string[]> {
    const messagesToDelete: string[] = [];

    state.phase = "scanning";
    state.status = "Fazendo varredura da conversa...";
    notifyUI();

    /**
     * A mensagem selecionada entra manualmente, porque
     * "before" e "max_id" não a retornam.
     */
    if (
        options.includeTarget &&
        !state.cancelled &&
        options.targetMessage.author?.id === myUserId &&
        isInRange(options.targetMessage.id, options)
    ) {
        registerMessage(
            options.targetMessage,
            options,
            myUserId,
            messagesToDelete,
        );

        notifyUI();
    }

    if (options.isGuildScan) {
        await scanGuildMessages(options, myUserId, messagesToDelete);
    } else {
        await scanDirectMessages(options, myUserId, messagesToDelete);
    }

    return messagesToDelete;
}

/* ============================================================
 * EXECUÇÃO (apagar ou editar)
 * ============================================================
 */

async function processMessages(
    options: PurgeOptions,
    messagesToProcess: string[],
) {
    if (state.cancelled) {
        return;
    }

    state.phase = "processing";
    state.found = messagesToProcess.length;

    state.status =
        `Varredura concluída. ${messagesToProcess.length} mensagens encontradas.`;

    notifyUI();

    await sleep(500);

    const target =
        options.maxMessages > 0
            ? Math.min(messagesToProcess.length, options.maxMessages)
            : messagesToProcess.length;

    const selected = messagesToProcess.slice(0, target);

    for (const messageId of selected) {
        if (state.cancelled) {
            break;
        }

        await waitIfPaused();

        if (state.cancelled) {
            break;
        }

        state.status =
            `${doingLabel(options.action)} ${state.deleted + state.failed + 1}/${target}...`;

        notifyUI();

        const success = await applyWithRetry(options, messageId);

        if (success) {
            state.deleted++;
        } else if (!state.cancelled) {
            state.failed++;
        }

        notifyUI();

        await sleep(1000);
    }

    if (state.cancelled) {
        return;
    }

    if (
        options.maxMessages > 0 &&
        state.deleted >= options.maxMessages
    ) {
        state.status = "Limite atingido.";
    } else if (state.failed > 0) {
        state.status = "Concluído com erros.";
    } else {
        state.status = "Concluído.";
    }
}

async function purgeMessages(options: PurgeOptions) {
    if (state.running) {
        return;
    }

    resetState();

    state.running = true;
    state.phase = "scanning";
    state.action = options.action;
    state.isGuild = options.isGuildScan;
    state.ranged = options.minId !== null || options.maxId !== null;
    state.status = "Iniciando varredura...";
    notifyUI();

    const currentUser = UserStore.getCurrentUser();

    if (!currentUser) {
        state.running = false;
        state.phase = "finished";
        state.status = "Não foi possível obter seu usuário.";

        notifyUI();

        return;
    }

    try {
        const messages = await scanMessages(options, currentUser.id);

        if (state.cancelled) {
            state.phase = "finished";
            state.status = "Cancelado.";
        } else if (messages.length === 0) {
            state.phase = "finished";
            state.status =
                "Nenhuma mensagem correspondente foi encontrada.";
        } else {
            await processMessages(options, messages);
        }
    } catch (error) {
        console.error("[MessagePurger] Erro:", error);

        state.status = "Erro durante a operação.";
    }

    if (state.cancelled) {
        state.status = "Cancelado.";
    }

    state.running = false;
    state.paused = false;
    state.phase = "finished";

    notifyUI();
}

/* ============================================================
 * MODAL DE PROGRESSO
 * ============================================================
 */

function ProgressModal(props: ModalProps) {
    const [, forceUpdate] = useState(0);

    useEffect(() => {
        updateModal = () => {
            forceUpdate(value => value + 1);
        };

        return () => {
            updateModal = undefined;
        };
    }, []);

    const progress = getProgressPercentage();

    const elapsed =
        state.startedAt > 0
            ? Math.floor((Date.now() - state.startedAt) / 1000)
            : 0;

    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;

    const phaseLabel =
        state.phase === "scanning"
            ? "VARREDURA"
            : state.phase === "processing"
                ? phaseName(state.action)
                : state.phase === "finished"
                    ? "FINALIZADO"
                    : "AGUARDANDO";

    return (
        <ModalRoot
            {...props}
            size={ModalSize.MEDIUM}
            className="message-purger-modal"
        >
            <ModalHeader>
                <div className="message-purger-title">
                    Message Purger
                </div>

                <ModalCloseButton onClick={props.onClose} />
            </ModalHeader>

            <ModalContent>
                <div className="message-purger-content">
                    <div className="message-purger-phase">
                        [{phaseLabel}]
                    </div>

                    <div className="message-purger-status">
                        {state.status}
                    </div>

                    <div className="message-purger-progress">
                        <div
                            className="message-purger-progress-fill"
                            style={{ width: `${progress}%` }}
                        />
                    </div>

                    <div className="message-purger-percent">
                        {progress}%
                    </div>

                    <div className="message-purger-stats">
                        {!state.isGuild && (
                            <div>
                                <span>
                                    {state.ranged
                                        ? "Total no intervalo:"
                                        : "Total na conversa:"}
                                </span>
                                <strong>{state.totalMessages}</strong>
                            </div>
                        )}

                        <div>
                            <span>Mensagens suas:</span>
                            <strong>{state.ownMessages}</strong>
                        </div>

                        <div>
                            <span>Correspondentes ao filtro:</span>
                            <strong>{state.eligibleMessages}</strong>
                        </div>

                        <div>
                            <span>{doneLabel(state.action)}:</span>
                            <strong>{state.deleted}</strong>
                        </div>

                        <div>
                            <span>Falharam:</span>
                            <strong>{state.failed}</strong>
                        </div>

                        <div>
                            <span>Verificadas:</span>
                            <strong>{state.scanned}</strong>
                        </div>

                        <div>
                            <span>Tempo:</span>
                            <strong>
                                {minutes}m {seconds}s
                            </strong>
                        </div>
                    </div>

                    {state.phase === "scanning" && (
                        <div className="message-purger-info">
                            A barra mostra o progresso da
                            varredura.
                            {state.isGuild
                                ? " Em servidores, somente as suas mensagens são consultadas."
                                : ""}
                            {" "}Quando terminar, ela passará a
                            representar a porcentagem de
                            mensagens {state.action === "edit"
                                ? "editadas"
                                : "apagadas"}.
                        </div>
                    )}

                    {state.phase === "processing" && (
                        <div className="message-purger-info">
                            {state.eligibleMessages} mensagens
                            correspondem ao filtro. A barra
                            representa
                            {state.action === "edit"
                                ? " a edição "
                                : " a exclusão "}
                            dessas mensagens.
                        </div>
                    )}

                    {state.paused && state.running && (
                        <div className="message-purger-warning">
                            PAUSADO
                        </div>
                    )}

                    {state.cancelled && (
                        <div className="message-purger-warning">
                            CANCELANDO...
                        </div>
                    )}
                </div>
            </ModalContent>

            <ModalFooter>
                {state.running && !state.cancelled && (
                    <>
                        <Button
                            color={Button.Colors.PRIMARY}
                            onClick={() => {
                                state.paused = !state.paused;

                                state.status = state.paused
                                    ? "Pausado."
                                    : state.phase === "scanning"
                                        ? "Continuando varredura..."
                                        : "Continuando...";

                                notifyUI();
                            }}
                        >
                            {state.paused ? "Continuar" : "Pausar"}
                        </Button>

                        <Button
                            color={Button.Colors.RED}
                            onClick={() => {
                                state.cancelled = true;
                                state.paused = false;
                                state.status = "Cancelando...";

                                notifyUI();
                            }}
                        >
                            Cancelar
                        </Button>
                    </>
                )}

                {!state.running && (
                    <Button
                        color={Button.Colors.PRIMARY}
                        onClick={props.onClose}
                    >
                        Fechar
                    </Button>
                )}
            </ModalFooter>
        </ModalRoot>
    );
}

function openProgressModal() {
    openModal(props => <ProgressModal {...props} />);
}

/* ============================================================
 * MODAL DE CONFIRMAÇÃO
 * ============================================================
 */

interface ConfirmPurgeModalProps extends ModalProps {
    message: DiscordMessage;
    includeTarget: boolean;
}

function ConfirmPurgeModal(props: ConfirmPurgeModalProps) {
    const { message, includeTarget, onClose } = props;

    const channel = ChannelStore.getChannel(message.channel_id) as
        | { guild_id?: string | null }
        | undefined;

    const guildId = channel?.guild_id ?? null;

    const [action, setAction] = useState<PurgeAction>("delete");
    const [filterMode, setFilterMode] = useState<FilterMode>("all");
    const [maxMessages, setMaxMessages] = useState("0");
    const [editText, setEditText] = useState("");
    const [starting, setStarting] = useState(false);

    const [rangeMode, setRangeMode] = useState<RangeMode>("all");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");

    const editInvalid =
        action === "edit" && editText.trim().length === 0;

    // Só vale se a mensagem marcada for do mesmo canal.
    const marker =
        endMarker && endMarker.channelId === message.channel_id
            ? endMarker
            : undefined;

    function buildRange(): {
        minId: bigint | null;
        maxId: bigint | null;
        error: string | null;
    } {
        let minId: bigint | null = null;
        let maxId: bigint | null = null;

        if (rangeMode === "date") {
            if (dateFrom) {
                minId = dateToSnowflake(
                    new Date(`${dateFrom}T00:00:00`).getTime(),
                );
            }

            if (dateTo) {
                maxId = dateToSnowflake(
                    new Date(`${dateTo}T23:59:59.999`).getTime(),
                );
            }

            if (
                minId !== null &&
                maxId !== null &&
                minId > maxId
            ) {
                return {
                    minId,
                    maxId,
                    error: "A data inicial é depois da data final.",
                };
            }
        }

        if (rangeMode === "message") {
            if (!marker) {
                return {
                    minId,
                    maxId,
                    error: "Nenhuma mensagem foi marcada neste canal.",
                };
            }

            if (BigInt(marker.id) >= BigInt(message.id)) {
                return {
                    minId,
                    maxId,
                    error: "A mensagem marcada precisa ser mais antiga que a selecionada.",
                };
            }

            minId = BigInt(marker.id);
        }

        return { minId, maxId, error: null };
    }

    const range = buildRange();

    function start() {
        if (starting || editInvalid || range.error !== null) {
            return;
        }

        let parsedMax = Number.parseInt(maxMessages, 10);

        if (!Number.isFinite(parsedMax) || parsedMax < 0) {
            parsedMax = 0;
        }

        setStarting(true);

        onClose();

        resetState();

        openProgressModal();

        void purgeMessages({
            channelId: message.channel_id,
            guildId,
            isGuildScan: guildId !== null,
            targetMessage: message,
            includeTarget,
            maxMessages: parsedMax,
            filterMode,
            action,
            editText: editText.trim(),
            minId: range.minId,
            maxId: range.maxId,
        });
    }

    const filters: FilterMode[] = ["all", "attachments", "images"];

    return (
        <ModalRoot
            {...props}
            size={ModalSize.MEDIUM}
            className="message-purger-modal"
        >
            <ModalHeader>
                <div className="message-purger-title">
                    {action === "edit"
                        ? "Editar mensagens"
                        : "Apagar mensagens"}
                </div>

                <ModalCloseButton onClick={onClose} />
            </ModalHeader>

            <ModalContent>
                <div className="message-purger-content">
                    <div className="message-purger-description">
                        {action === "edit"
                            ? "Você está prestes a editar suas mensagens anteriores a esta mensagem."
                            : "Você está prestes a apagar suas mensagens anteriores a esta mensagem."}
                    </div>

                    {includeTarget && (
                        <div className="message-purger-warning">
                            A mensagem selecionada também será
                            incluída.
                        </div>
                    )}

                    <div className="message-purger-section">
                        <div className="message-purger-label">
                            Ação
                        </div>

                        <div className="message-purger-buttons">
                            <Button
                                color={
                                    action === "delete"
                                        ? Button.Colors.PRIMARY
                                        : Button.Colors.TRANSPARENT
                                }
                                onClick={() => setAction("delete")}
                            >
                                Apagar
                            </Button>

                            <Button
                                color={
                                    action === "edit"
                                        ? Button.Colors.PRIMARY
                                        : Button.Colors.TRANSPARENT
                                }
                                onClick={() => setAction("edit")}
                            >
                                Editar
                            </Button>
                        </div>
                    </div>

                    {action === "edit" && (
                        <div className="message-purger-section">
                            <div className="message-purger-label">
                                Novo texto
                            </div>

                            <input
                                className="message-purger-input"
                                type="text"
                                maxLength={2000}
                                placeholder="Texto que substituirá o conteúdo"
                                value={editText}
                                onChange={event =>
                                    setEditText(event.target.value)
                                }
                            />

                            <div className="message-purger-help">
                                O texto de todas as mensagens
                                selecionadas será trocado por este.
                                Anexos não são removidos.
                            </div>
                        </div>
                    )}

                    <div className="message-purger-section">
                        <div className="message-purger-label">
                            Até onde
                        </div>

                        <div className="message-purger-buttons">
                            <Button
                                color={
                                    rangeMode === "all"
                                        ? Button.Colors.PRIMARY
                                        : Button.Colors.TRANSPARENT
                                }
                                onClick={() => setRangeMode("all")}
                            >
                                Início da conversa
                            </Button>

                            <Button
                                color={
                                    rangeMode === "date"
                                        ? Button.Colors.PRIMARY
                                        : Button.Colors.TRANSPARENT
                                }
                                onClick={() => setRangeMode("date")}
                            >
                                Período
                            </Button>

                            <Button
                                color={
                                    rangeMode === "message"
                                        ? Button.Colors.PRIMARY
                                        : Button.Colors.TRANSPARENT
                                }
                                onClick={() => setRangeMode("message")}
                            >
                                Até uma mensagem
                            </Button>
                        </div>

                        {rangeMode === "all" && (
                            <div className="message-purger-help">
                                Vai até o começo do histórico.
                            </div>
                        )}

                        {rangeMode === "date" && (
                            <>
                                <div className="message-purger-help">
                                    De (mais antiga):
                                </div>

                                <input
                                    className="message-purger-input"
                                    type="date"
                                    value={dateFrom}
                                    onChange={event =>
                                        setDateFrom(event.target.value)
                                    }
                                />

                                <div className="message-purger-help">
                                    Até (mais recente):
                                </div>

                                <input
                                    className="message-purger-input"
                                    type="date"
                                    value={dateTo}
                                    onChange={event =>
                                        setDateTo(event.target.value)
                                    }
                                />

                                <div className="message-purger-help">
                                    Só mensagens anteriores à
                                    selecionada e dentro do período.
                                    Deixe um campo em branco para não
                                    limitar aquele lado.
                                </div>
                            </>
                        )}

                        {rangeMode === "message" && marker && (
                            <div className="message-purger-info">
                                Limite final:{" "}
                                {snowflakeToDate(
                                    marker.id,
                                ).toLocaleString("pt-BR")}
                                <br />
                                {marker.preview}
                                <br />
                                Essa mensagem também entra no
                                intervalo.
                            </div>
                        )}

                        {rangeMode === "message" && !marker && (
                            <div className="message-purger-info">
                                Clique com o botão direito em uma
                                mensagem mais antiga e escolha
                                &quot;Marcar como limite final&quot;.
                                Depois abra este painel de novo.
                            </div>
                        )}

                        {range.error && (
                            <div className="message-purger-warning">
                                {range.error}
                            </div>
                        )}
                    </div>

                    <div className="message-purger-section">
                        <div className="message-purger-label">
                            Filtro
                        </div>

                        <div className="message-purger-buttons">
                            {filters.map(mode => (
                                <Button
                                    key={mode}
                                    color={
                                        filterMode === mode
                                            ? Button.Colors.PRIMARY
                                            : Button.Colors.TRANSPARENT
                                    }
                                    onClick={() => setFilterMode(mode)}
                                >
                                    {getFilterName(mode)}
                                </Button>
                            ))}
                        </div>

                        <div className="message-purger-help">
                            Filtro atual: {getFilterName(filterMode)}
                        </div>
                    </div>

                    <div className="message-purger-section">
                        <div className="message-purger-label">
                            Limite
                        </div>

                        <input
                            className="message-purger-input"
                            type="number"
                            min="0"
                            value={maxMessages}
                            onChange={event =>
                                setMaxMessages(event.target.value)
                            }
                        />

                        <div className="message-purger-help">
                            0 = sem limite.
                        </div>
                    </div>

                    {guildId !== null && (
                        <div className="message-purger-info">
                            Neste servidor, somente as suas
                            mensagens serão consultadas.
                        </div>
                    )}

                    <div className="message-purger-warning">
                        O Discord apaga a mensagem inteira. O
                        filtro de anexos e imagens significa que
                        somente mensagens que possuem esse tipo de
                        mídia serão afetadas.
                    </div>
                </div>
            </ModalContent>

            <ModalFooter>
                <Button
                    color={Button.Colors.PRIMARY}
                    onClick={onClose}
                    disabled={starting}
                >
                    Cancelar
                </Button>

                <Button
                    color={Button.Colors.RED}
                    onClick={start}
                    disabled={
                        starting ||
                        editInvalid ||
                        range.error !== null
                    }
                >
                    {starting
                        ? "Iniciando..."
                        : action === "edit"
                            ? "Editar mensagens"
                            : "Apagar mensagens"}
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

function openConfirm(message: DiscordMessage, includeTarget: boolean) {
    openModal(props => (
        <ConfirmPurgeModal
            {...props}
            message={message}
            includeTarget={includeTarget}
        />
    ));
}

/* ============================================================
 * MENU DE CONTEXTO
 * ============================================================
 */

const patchMessageContextMenu: NavContextMenuPatchCallback = (
    children,
    { message },
) => {
    if (!message) {
        return;
    }

    const typedMessage = message as DiscordMessage;

    const currentUser = UserStore.getCurrentUser();

    if (!currentUser) {
        return;
    }

    // Marcar o limite final vale para qualquer mensagem do canal.
    const isMarked = endMarker?.id === typedMessage.id;

    children.push(
        <Menu.MenuItem
            id="message-purger-marker"
            label={
                isMarked
                    ? "Remover marcação de limite final"
                    : "Marcar como limite final (apagar/editar)"
            }
            action={() => {
                if (isMarked) {
                    endMarker = undefined;

                    return;
                }

                const text = (typedMessage.content ?? "").trim();

                endMarker = {
                    id: typedMessage.id,
                    channelId: typedMessage.channel_id,
                    preview:
                        text.length > 60
                            ? `${text.slice(0, 60)}...`
                            : text || "(mensagem sem texto)",
                };
            }}
        />,
    );

    if (typedMessage.author?.id !== currentUser.id) {
        return;
    }

    children.push(
        <Menu.MenuItem
            id="message-purger-before"
            label="Apagar/editar minhas mensagens anteriores"
            color="danger"
            action={() => openConfirm(typedMessage, false)}
        />,
    );

    children.push(
        <Menu.MenuItem
            id="message-purger-before-this"
            label="Apagar/editar minhas mensagens anteriores + esta"
            color="danger"
            action={() => openConfirm(typedMessage, true)}
        />,
    );
};

/* ============================================================
 * TOOLBAR
 * ============================================================
 */

function updateToolbarButton() {
    if (!toolbarButton) {
        return;
    }

    const progress = getProgressPercentage();

    const fill = toolbarButton.querySelector<HTMLElement>(
        ".message-purger-toolbar-progress-fill",
    );

    const percent = toolbarButton.querySelector<HTMLElement>(
        ".message-purger-toolbar-percent",
    );

    const status = toolbarButton.querySelector<HTMLElement>(
        ".message-purger-toolbar-status",
    );

    if (fill) {
        fill.style.width = `${progress}%`;
    }

    if (percent) {
        percent.textContent = `${progress}%`;
    }

    if (status) {
        status.textContent = state.status;
    }

    let title = "Message Purger";

    if (state.running) {
        title += ` — ${state.status}`;
    } else if (state.phase === "finished") {
        title += ` — ${state.deleted} ${doneLabel(state.action).toLowerCase()}`;
    }

    toolbarButton.title = title;
}

function createToolbarButton(): HTMLButtonElement {
    const button = document.createElement("button");

    button.id = TOOLBAR_BUTTON_ID;
    button.className = "message-purger-toolbar-button";
    button.type = "button";

    button.innerHTML = `
        <span class="message-purger-toolbar-fox">
            🦊
        </span>

        <span class="message-purger-toolbar-info">
            <span class="message-purger-toolbar-percent">
                0%
            </span>

            <span class="message-purger-toolbar-progress">
                <span class="message-purger-toolbar-progress-fill"></span>
            </span>

            <span class="message-purger-toolbar-status">
                Pronto
            </span>
        </span>
    `;

    button.addEventListener("click", () => {
        openProgressModal();
    });

    toolbarButton = button;

    updateToolbarButton();

    return button;
}

function findDiscordToolbar(): HTMLElement | null {
    const toolbars = document.querySelectorAll<HTMLElement>(
        '[class*="toolbar_"]',
    );

    for (const toolbar of toolbars) {
        const rect = toolbar.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0) {
            return toolbar;
        }
    }

    return null;
}

function ensureToolbarButton() {
    const existing = document.getElementById(TOOLBAR_BUTTON_ID);

    if (existing) {
        toolbarButton = existing as HTMLButtonElement;

        updateToolbarButton();

        return;
    }

    const toolbar = findDiscordToolbar();

    if (!toolbar) {
        return;
    }

    const button = createToolbarButton();

    toolbar.insertBefore(button, toolbar.firstChild);
}

function startToolbarObserver() {
    ensureToolbarButton();

    toolbarObserver = new MutationObserver(() => {
        if (!document.getElementById(TOOLBAR_BUTTON_ID)) {
            ensureToolbarButton();
        }
    });

    toolbarObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

function stopToolbarObserver() {
    toolbarObserver?.disconnect();

    toolbarObserver = undefined;

    toolbarButton?.remove();

    toolbarButton = undefined;
}

export default definePlugin({
    name: "MessagePurger",

    description:
        "Apaga ou edita suas próprias mensagens em segundo plano.",

    authors: [
        {
            name: "kiub",
            id: 0n,
        },
    ],

    tags: ["Chat", "Utility"],

    contextMenus: {
        message: patchMessageContextMenu,
    },

    start() {
        startToolbarObserver();
        updateToolbarButton();
    },

    stop() {
        endMarker = undefined;
        state.cancelled = true;
        state.paused = false;
        state.running = false;

        stopToolbarObserver();
    },
});
